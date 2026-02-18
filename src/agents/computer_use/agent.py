"""
Computer Use Agent — Ollama-powered local browser automation.

Uses Playwright to control a Chromium browser and Ollama with a multimodal
vision-language model (default: qwen3-vl:4b) to decide actions. The agent
takes screenshots + DOM text, asks the model for a JSON action, and executes
it in a loop until the task is complete.

No API keys required — runs 100 % locally.
"""

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .browser import BrowserSession

logger = logging.getLogger(__name__)

# ── URL helpers ───────────────────────────────────────────────────────────

def _clean_extracted_url(raw_url: str) -> str:
    """Strip trailing punctuation from a regex-extracted URL, preserving balanced parentheses.

    Wikipedia-style URLs like https://en.wikipedia.org/wiki/Python_(programming_language)
    have meaningful parentheses that naive rstrip(')') would break.
    """
    # Strip obvious trailing punctuation that's never part of a URL
    url = raw_url.rstrip(".,;:")

    # Handle trailing parentheses: only strip ')' if it's unbalanced
    while url.endswith(")"):
        opens = url.count("(")
        closes = url.count(")")
        if closes > opens:
            url = url[:-1]
        else:
            break

    return url


# ── System prompt ─────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a browser automation agent. Each turn you get: page text, interactive ELEMENTS with exact coordinates, and a screenshot. Output ONE JSON action. /no_think

OUTPUT FORMAT (no markdown, no explanation, ONLY this JSON):
{{"thought": "why", "action": "ACTION", "params": {{...}}}}

ACTIONS:
navigate       {{"url": "https://..."}}
click          {{"x": INT, "y": INT}}
type_text      {{"text": "..."}}
click_and_type {{"x": INT, "y": INT, "text": "..."}}
press_key      {{"key": "Enter"}}
scroll         {{"direction": "down", "amount": 1}}
done           {{"result": "your answer here", "success": true}}

STRATEGY:
1. READ the page text — if the answer is there, call "done" immediately.
2. Use ELEMENTS coordinates for click/click_and_type — they are exact, do NOT guess coordinates.
3. To search: find the search input in ELEMENTS, use click_and_type with its (x,y), then press_key Enter.
4. Only SCROLL if content is below the fold and not in the page text.
5. NEVER repeat the same action. Be direct — fewest steps possible.

Viewport: {width}x{height}."""

# Maximum characters of DOM text to include per step
MAX_PAGE_TEXT_CHARS = 1500

# Maximum interactive elements to include per step
MAX_INTERACTIVE_ELEMENTS = 15


def _format_elements(elements: list[dict]) -> str:
    """Format interactive elements as a compact text list for the model prompt."""
    if not elements:
        return "(no interactive elements found)"
    lines = []
    for el in elements:
        tag = el.get("tag", "?")
        el_type = el.get("type", "")
        text = el.get("text", "")
        placeholder = el.get("placeholder", "")
        x, y = el.get("x", 0), el.get("y", 0)

        # Build a concise description
        label = placeholder or text or el_type or tag
        if len(label) > 50:
            label = label[:47] + "..."
        kind = f"{tag}" + (f"[{el_type}]" if el_type and el_type != tag else "")
        lines.append(f"  ({x},{y}) {kind} \"{label}\"")
    return "\n".join(lines)


# Maximum messages to keep in history (system + N user/assistant pairs)
MAX_HISTORY_MESSAGES = 8


# ── Data classes ───────────────────────────────────────────────────────────

@dataclass
class StepRecord:
    """Record of a single agent step."""
    step_number: int
    timestamp: float
    action: str
    action_input: dict
    reasoning: str
    result: str
    success: bool
    screenshot_b64: Optional[str] = None
    duration_seconds: float = 0.0
    json_parse_retries: int = 0


@dataclass
class TaskExecution:
    """Complete record of a task execution."""
    task_input: str
    started_at: float = 0.0
    completed_at: float = 0.0
    steps: list = field(default_factory=list)
    final_result: str = ""
    task_success: bool = False
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    total_cost_usd: float = 0.0
    error: Optional[str] = None
    failure_reason: Optional[str] = None  # human-readable stuck/abort explanation

    @property
    def duration_seconds(self) -> float:
        return self.completed_at - self.started_at if self.completed_at else 0.0

    @property
    def step_count(self) -> int:
        return len(self.steps)

    def to_tool_calls(self) -> list:
        """Convert steps to AgentEval-compatible tool_calls format."""
        return [
            {
                "name": step.action,
                "arguments": step.action_input,
                "result": step.result,
                "success": step.success,
                "reasoning": step.reasoning,
                "step_number": step.step_number,
                "duration_seconds": step.duration_seconds,
            }
            for step in self.steps
        ]


# ── JSON extraction helpers ───────────────────────────────────────────────

def _find_balanced_braces(text: str) -> list[str]:
    """Find all brace-balanced {…} substrings, handling arbitrary nesting depth."""
    results = []
    i = 0
    while i < len(text):
        if text[i] == '{':
            depth = 1
            start = i
            i += 1
            in_string = False
            escape = False
            while i < len(text) and depth > 0:
                ch = text[i]
                if escape:
                    escape = False
                elif ch == '\\' and in_string:
                    escape = True
                elif ch == '"' and not escape:
                    in_string = not in_string
                elif not in_string:
                    if ch == '{':
                        depth += 1
                    elif ch == '}':
                        depth -= 1
                i += 1
            if depth == 0:
                results.append(text[start:i])
        else:
            i += 1
    return results


def _extract_json_action(text: str) -> Optional[dict]:
    """Try hard to pull a JSON action object from the model's response text.

    Attempts in order:
      0. Strip <think>…</think> blocks (thinking models)
      1. Direct json.loads on stripped text
      2. Extract from ```json ... ``` fences
      3. Brace-balanced extraction (handles any nesting depth)
      4. Lenient cleanup (trailing commas, single quotes)
    Returns None if all fail.
    """
    # 0. Strip thinking tags
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    # 1. Direct parse
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    # 2. Markdown fenced block
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if fence_match:
        try:
            obj = json.loads(fence_match.group(1).strip())
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    # 3. Brace-balanced extraction — finds all {…} with proper nesting
    candidates = _find_balanced_braces(text)
    # Try largest first (most likely to be the full action object)
    for candidate in sorted(candidates, key=len, reverse=True):
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict) and "action" in obj:
                return obj
        except json.JSONDecodeError:
            pass
        # Also try without requiring "action" key (might be wrapped differently)
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    # 4. Lenient cleanup — fix trailing commas, single quotes
    for candidate in sorted(candidates, key=len, reverse=True):
        cleaned = re.sub(r",\s*([}\]])", r"\1", candidate)  # trailing commas
        cleaned = cleaned.replace("'", '"')  # single quotes → double
        try:
            obj = json.loads(cleaned)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue

    return None


# ── Agent ──────────────────────────────────────────────────────────────────

class ComputerUseAgent:
    """Ollama-powered local browser automation agent."""

    def __init__(
        self,
        ollama_host: str = "http://localhost:11434",
        ollama_model: str = "cua-agent",
        max_steps: int = 15,
        viewport_width: int = 1280,
        viewport_height: int = 720,
        json_retries: int = 2,
        headless: bool = True,
        action_timeout: float = 30.0,
        num_ctx: int = 16384,
    ):
        self.ollama_host = ollama_host.rstrip("/")
        self.model = ollama_model
        self.max_steps = max_steps
        self.viewport_width = viewport_width
        self.viewport_height = viewport_height
        self.json_retries = json_retries
        self.headless = headless
        self.action_timeout = action_timeout  # seconds per action (Ollama call + browser action)
        self.num_ctx = num_ctx  # must match Modelfile num_ctx — used for context-full detection only

    # ── Ollama HTTP call ────────────────────────────────────────────

    _empty_content_strikes: int = 0  # Track consecutive empty-content responses

    MAX_EMPTY_RETRIES = 2  # Retry empty-content responses before falling back

    async def _call_ollama(self, messages: list) -> str:
        """Send a chat request to Ollama and return the assistant text.

        Retries up to MAX_EMPTY_RETRIES times if the model returns empty content
        (common with qwen3-vl thinking mode leaks).
        """
        # All model parameters (temperature, num_predict, num_ctx, etc.) are
        # defined in the Modelfile — the single source of truth.  We do NOT
        # pass "options" here so the Modelfile values are used as-is.
        # The /no_think directive is also baked into the Modelfile template.
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
        }
        ollama_timeout = max(self.action_timeout * 4, 120.0)

        for retry in range(1 + self.MAX_EMPTY_RETRIES):
            async with httpx.AsyncClient(timeout=httpx.Timeout(ollama_timeout)) as client:
                resp = await client.post(
                    f"{self.ollama_host}/api/chat",
                    json=payload,
                )
                if resp.status_code != 200:
                    body = resp.text[:500]
                    logger.error(f"Ollama returned {resp.status_code}: {body}")
                    raise httpx.HTTPStatusError(
                        f"Ollama {resp.status_code}: {body}",
                        request=resp.request, response=resp,
                    )
                data = resp.json()

            content = data.get("message", {}).get("content", "")
            thinking = data.get("message", {}).get("thinking", "")
            done_reason = data.get("done_reason", "unknown")
            prompt_tokens = data.get("prompt_eval_count", 0)
            eval_tokens = data.get("eval_count", 0)

            # ── Diagnostic logging ──
            if content:
                logger.info(
                    f"Ollama raw content ({len(content)} chars, thinking={len(thinking)} chars, "
                    f"done_reason={done_reason}): {content[:300]!r}"
                )
            else:
                logger.info(
                    f"Ollama raw content: EMPTY (thinking={len(thinking)} chars, "
                    f"eval_count={eval_tokens}, done_reason={done_reason})"
                )

            # ── Strip <think> blocks from content ──
            content_clean = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()

            # Also try the thinking field — if content is empty but thinking has
            # actual JSON in it (model confused about where to put output)
            if not content_clean and thinking:
                thinking_clean = re.sub(r"<think>.*?</think>", "", thinking, flags=re.DOTALL).strip()
                if thinking_clean and "{" in thinking_clean:
                    logger.warning(
                        f"Found potential JSON in thinking field ({len(thinking_clean)} chars). "
                        f"Using thinking content as fallback."
                    )
                    content_clean = thinking_clean

            if content_clean:
                self._empty_content_strikes = 0
                return content_clean

            # Empty content — retry or fall back
            context_full = prompt_tokens >= self.num_ctx * 0.9
            if context_full:
                logger.warning("Context window genuinely full — returning scroll fallback")
                return '{"thought": "Context window full, scrolling to continue", "action": "scroll", "params": {"direction": "down", "amount": 1}}'

            if retry < self.MAX_EMPTY_RETRIES:
                logger.warning(
                    f"Empty content (retry {retry + 1}/{self.MAX_EMPTY_RETRIES}). "
                    f"eval_count={eval_tokens}, done_reason={done_reason}. Retrying..."
                )
                continue

        # All retries exhausted
        self._empty_content_strikes += 1
        logger.warning(
            f"Ollama returned empty content after {self.MAX_EMPTY_RETRIES + 1} attempts. "
            f"strikes={self._empty_content_strikes}, prompt_tokens={prompt_tokens}, "
            f"eval_tokens={eval_tokens}"
        )

        if self._empty_content_strikes <= 1:
            return '{"thought": "Model output was empty after retries, reading page text to recover", "action": "read_page_text", "params": {}}'
        else:
            return (
                '{"thought": "Model could not generate action after multiple attempts", '
                '"action": "done", "params": {"result": "Model failed to produce output — task incomplete", "success": false}}'
            )

    # ── Get next action with retries ────────────────────────────────

    async def _get_action(self, messages: list) -> tuple[dict, str, int]:
        """Call Ollama and extract a JSON action, retrying on parse failure.

        Returns (action_dict, raw_response, retry_count).
        """
        retries = 0
        raw = ""

        for attempt in range(1 + self.json_retries):
            raw = await self._call_ollama(messages)
            action = _extract_json_action(raw)
            if action and "action" in action:
                return action, raw, retries

            retries += 1
            if attempt < self.json_retries:
                # Append a correction message and retry
                messages = messages + [
                    {"role": "assistant", "content": raw},
                    {
                        "role": "user",
                        "content": (
                            "Your previous response was not valid JSON. "
                            "Do NOT think or explain. Respond with ONLY a raw JSON object, nothing else:\n"
                            '{"thought": "...", "action": "...", "params": {...}}'
                        ),
                    },
                ]
                logger.warning(f"JSON parse failed (attempt {attempt + 1}), raw output: {raw[:500]}")

        # Total failure — return done instead of scroll. Scrolling won't help
        # when the model can't produce valid JSON; it just causes a stuck loop.
        logger.error(f"JSON extraction failed after {retries} retries. Raw: {raw[:500]}")
        return {"thought": "JSON parse failure — cannot produce valid action", "action": "done", "params": {"result": "Model failed to produce valid JSON action", "success": False}}, raw, retries

    # ── Stuck detection ────────────────────────────────────────────

    # Thresholds (configurable via constructor if needed later)
    MAX_CONSECUTIVE_TIMEOUTS = 3
    MAX_CONSECUTIVE_FAILURES = 4
    MAX_CONSECUTIVE_REPEATS = 3
    MAX_TOTAL_JSON_PARSE_FAILURES = 10

    def _check_stuck(self, steps: list) -> Optional[str]:
        """Analyse recent steps and return a failure reason if the agent is stuck.

        Returns None if everything looks fine, or a human-readable explanation
        string if the agent should abort early.
        """
        if len(steps) < 2:
            return None

        # ── 1. Consecutive timeouts ──────────────────────────────────
        tail_timeouts = 0
        for s in reversed(steps):
            if s.action == "timeout":
                tail_timeouts += 1
            else:
                break
        if tail_timeouts >= self.MAX_CONSECUTIVE_TIMEOUTS:
            thinking_to = max(self.action_timeout * 4, 120.0)
            return (
                f"Agent stuck: {tail_timeouts} consecutive action timeouts "
                f"(thinking: {thinking_to}s, acting: {self.action_timeout}s). "
                f"The vision model may be overloaded or unresponsive."
            )

        # ── 2. Consecutive failed actions ────────────────────────────
        tail_failures = 0
        for s in reversed(steps):
            if not s.success and s.action != "timeout":
                tail_failures += 1
            else:
                break
        if tail_failures >= self.MAX_CONSECUTIVE_FAILURES:
            last_actions = [s.action for s in steps[-tail_failures:]]
            return (
                f"Agent stuck: {tail_failures} consecutive failed actions "
                f"({', '.join(last_actions)}). The agent cannot make progress."
            )

        # ── 3. Repeating the exact same action ──────────────────────
        if len(steps) >= self.MAX_CONSECUTIVE_REPEATS:
            window = steps[-self.MAX_CONSECUTIVE_REPEATS:]
            actions_same = all(
                s.action == window[0].action and s.action_input == window[0].action_input
                for s in window[1:]
            )
            if actions_same and window[0].action not in ("done",):
                # For scroll actions, only flag as stuck if the page stopped moving
                if window[0].action == "scroll":
                    positions = set()
                    for s in window:
                        pos_match = re.search(r"Position: (\d+)%", s.result)
                        if pos_match:
                            positions.add(pos_match.group(1))
                    if len(positions) > 1:
                        pass  # Page is still moving — not stuck
                    else:
                        return (
                            f"Agent stuck: scrolled {self.MAX_CONSECUTIVE_REPEATS} times "
                            f"but page position didn't change (hit {'bottom' if 'down' in str(window[0].action_input) else 'top'}). "
                            f"Params: {window[0].action_input}"
                        )
                # For type_text with substantial text, the model has the answer but
                # is confused about how to return it — auto-rescue as "done"
                elif window[0].action == "type_text" and len(window[0].action_input.get("text", "")) > 10:
                    return f"__auto_done__:{window[0].action_input['text']}"
                # For read_page_text loops, the model has the page content but
                # can't formulate a done — rescue with the last page text result
                elif window[0].action == "read_page_text":
                    last_text = window[-1].result or ""
                    # Strip the "Page text:\n" prefix if present
                    if last_text.startswith("Page text:\n"):
                        last_text = last_text[len("Page text:\n"):]
                    return f"__auto_done__:{last_text[:2000]}"
                # For click/select_option loops, the model may be trying to
                # submit a form but the click isn't working — try Enter key
                elif window[0].action in ("click", "select_option"):
                    return "__retry_enter__"
                else:
                    return (
                        f"Agent stuck: repeated '{window[0].action}' with identical parameters "
                        f"{self.MAX_CONSECUTIVE_REPEATS} times in a row. "
                        f"Params: {window[0].action_input}"
                    )

        # ── 4. Too many JSON parse failures across the run ──────────
        total_parse_failures = sum(s.json_parse_retries for s in steps)
        if total_parse_failures >= self.MAX_TOTAL_JSON_PARSE_FAILURES:
            return (
                f"Agent stuck: {total_parse_failures} JSON parse failures across "
                f"{len(steps)} steps. The model is not producing valid action JSON."
            )

        return None

    # ── Context window pruning ──────────────────────────────────────

    @staticmethod
    def _prune_messages(messages: list, keep_images: int = 1) -> list:
        """Keep first message (task) + last N messages to stay within context.

        Crucially, strip screenshot images from all but the most recent
        `keep_images` user messages.  Each 1280×900 PNG is ~0.5-1 MB of
        base64 and Ollama's vision encoder (ViT) must process every single
        one, which causes massive RAM spikes (7 GB → 40 GB) when the
        conversation accumulates many screenshots.
        """
        # 1. Trim to MAX_HISTORY_MESSAGES
        if len(messages) > MAX_HISTORY_MESSAGES:
            keep_tail = MAX_HISTORY_MESSAGES - 1
            messages = [messages[0]] + messages[-keep_tail:]
            logger.info(f"Pruned message history to {len(messages)} messages")

        # 2. Strip images from all but the last `keep_images` user messages
        #    Walk backwards, counting user messages that carry images.
        image_count = 0
        for msg in reversed(messages):
            if msg.get("role") == "user" and "images" in msg:
                image_count += 1
                if image_count > keep_images:
                    del msg["images"]

        return messages

    # ── Main execution loop ─────────────────────────────────────────

    async def execute_task(
        self,
        task_input: str,
        session_tracker=None,
        cancel_check=None,
        custom_system_prompt: str | None = None,
    ) -> TaskExecution:
        """Execute a browser task end-to-end.

        1. Launch browser session
        2. Loop: screenshot + DOM text → Ollama decides → execute → record
        3. Return structured execution record

        Args:
            task_input: The task description
            session_tracker: Optional (dict, key) tuple — the browser session
                             is registered in dict[key] so it can be killed externally.
            cancel_check: Optional callable returning True when the task should abort.
            custom_system_prompt: Optional additional system prompt from Prompt Lab.
                                  Prepended to the built-in browser automation prompt
                                  so the agent can receive task-level behavioural guidance.
        """
        execution = TaskExecution(task_input=task_input, started_at=time.time())
        self._empty_content_strikes = 0  # Reset per-task
        session = BrowserSession(
            viewport_width=self.viewport_width,
            viewport_height=self.viewport_height,
            headless=self.headless,
        )
        base_prompt = SYSTEM_PROMPT.format(
            width=self.viewport_width, height=self.viewport_height,
            page_text_limit=MAX_PAGE_TEXT_CHARS,
        )
        # If a custom system prompt was provided (e.g. from Prompt Lab),
        # prepend it so the agent gets behavioural guidance while keeping
        # the built-in browser automation instructions intact.
        if custom_system_prompt and custom_system_prompt.strip():
            system_prompt = (
                f"{custom_system_prompt.strip()}\n\n"
                f"--- BROWSER AUTOMATION INSTRUCTIONS ---\n\n"
                f"{base_prompt}"
            )
            logger.info("Using custom system prompt (%d chars) + built-in prompt", len(custom_system_prompt))
        else:
            system_prompt = base_prompt

        # Progress tracking — external callers can read these for live status
        self._current_step = 0
        self._current_step_started = 0.0
        self._current_phase = "starting"  # "starting", "thinking", "acting", "done"

        def _is_cancelled() -> bool:
            return cancel_check() if cancel_check else False

        try:
            await session.start()

            # Register session for external cancellation
            if session_tracker:
                tracker_dict, tracker_key = session_tracker
                tracker_dict[tracker_key] = session

            # ── Auto-navigate: if the task contains a URL, go there first ──
            # This saves the model from wasting a step parsing the URL from
            # the task text and avoids showing it a useless about:blank page.
            url_match = re.search(r'https?://[^\s\'"<>]+', task_input)
            if url_match:
                auto_url = _clean_extracted_url(url_match.group(0))
                logger.info(f"Auto-navigating to URL found in task: {auto_url}")
                nav_result = await session.navigate(auto_url)
                if nav_result.success:
                    execution.steps.append(StepRecord(
                        step_number=0,
                        timestamp=time.time(),
                        action="navigate",
                        action_input={"url": auto_url},
                        reasoning="Auto-navigated to URL found in task input",
                        result=nav_result.detail,
                        success=True,
                        screenshot_b64=nav_result.screenshot_b64,
                        duration_seconds=0.0,
                    ))

            initial_screenshot = await session.screenshot()
            initial_page_text = ""
            try:
                initial_page_text = await session.get_page_text()
            except Exception:
                pass
            initial_elements = await session.get_interactive_elements(MAX_INTERACTIVE_ELEMENTS)

            page_text_snippet = initial_page_text[:MAX_PAGE_TEXT_CHARS]
            elements_text = _format_elements(initial_elements)

            # Build the initial conversation
            nav_context = ""
            if url_match and execution.steps and execution.steps[0].success:
                nav_context = f"I have already navigated to {_clean_extracted_url(url_match.group(0))} for you. "

            messages = [
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": (
                        f"TASK: {task_input}\n\n"
                        f"{nav_context}"
                        f"PAGE TEXT (first {MAX_PAGE_TEXT_CHARS} chars):\n{page_text_snippet}\n\n"
                        f"ELEMENTS (use these exact coordinates for click/click_and_type):\n{elements_text}\n\n"
                        "Here is the current screenshot. What is your next action?"
                    ),
                    "images": [initial_screenshot],
                },
            ]

            for step_num in range(1, self.max_steps + 1):
                # Check for cancellation
                if _is_cancelled():
                    execution.final_result = "Task cancelled"
                    execution.task_success = False
                    break

                step_start = time.time()
                self._current_step = step_num
                self._current_step_started = step_start

                try:
                    # ── Phase 1: thinking (Ollama call) ──────────────────
                    self._current_phase = "thinking"
                    messages = self._prune_messages(messages)

                    # Thinking phase gets 4× the action timeout — vision model
                    # inference on complex pages (Wikipedia, news sites) can take
                    # 60-90s due to ViT encoder processing dense screenshots.
                    thinking_timeout = max(self.action_timeout * 4, 120.0)
                    action_obj, raw_response, parse_retries = await asyncio.wait_for(
                        self._get_action(messages),
                        timeout=thinking_timeout,
                    )

                    reasoning = action_obj.get("thought", "")
                    action_name = action_obj.get("action", "scroll")
                    action_params = action_obj.get("params", {})

                    # ── Quick-reject: intercept invalid actions before executing ──
                    # Empty find_text is a common 3B model mistake — redirect to done
                    if action_name == "find_text" and not action_params.get("query", "").strip():
                        logger.info(f"Step {step_num}: Rejected find_text with empty query — nudging model to use done")
                        messages.append({"role": "assistant", "content": raw_response})
                        messages.append({"role": "user", "content": (
                            "Invalid action: find_text requires a query. "
                            "The page text is already shown above — read it and answer the question. "
                            'Call done {"result": "your answer", "success": true} now.'
                        )})
                        continue  # skip to next step_num without recording a step

                    # ── Phase 2: acting (browser action) ─────────────────
                    self._current_phase = "acting"
                    action_result = await asyncio.wait_for(
                        self._execute_action(session, action_name, action_params),
                        timeout=self.action_timeout,
                    )

                except asyncio.TimeoutError:
                    phase_timeout = thinking_timeout if self._current_phase == "thinking" else self.action_timeout
                    logger.warning(
                        f"Step {step_num} timed out after {phase_timeout}s "
                        f"(phase: {self._current_phase})"
                    )
                    step = StepRecord(
                        step_number=step_num,
                        timestamp=time.time(),
                        action="timeout",
                        action_input={"phase": self._current_phase, "timeout_seconds": phase_timeout},
                        reasoning=f"Step timed out during {self._current_phase} phase after {phase_timeout}s",
                        result=f"Timeout ({self._current_phase})",
                        success=False,
                        duration_seconds=time.time() - step_start,
                    )
                    execution.steps.append(step)

                    # Check if agent is stuck after timeout
                    stuck_reason = self._check_stuck(execution.steps)
                    if stuck_reason:
                        if stuck_reason.startswith("__auto_done__:"):
                            answer = stuck_reason[len("__auto_done__:"):]
                            logger.info(f"Auto-rescued stuck action as done: {answer[:80]}...")
                            execution.final_result = answer
                            execution.task_success = True
                            execution.steps.append(StepRecord(
                                step_number=step_num + 1, timestamp=time.time(),
                                action="done", action_input={"result": answer, "success": True},
                                reasoning="Auto-rescued: model had the answer but repeated an action instead of calling done",
                                result=answer, success=True, duration_seconds=0,
                            ))
                        elif stuck_reason == "__retry_enter__":
                            # Click stuck after timeout — try Enter, then continue
                            logger.info(f"Click stuck after timeout at step {step_num} — trying Enter key")
                            try:
                                await session.press_key("Enter")
                            except Exception:
                                pass
                            continue
                        else:
                            logger.warning(f"Early abort at step {step_num}: {stuck_reason}")
                            execution.failure_reason = stuck_reason
                            execution.final_result = f"Aborted: {stuck_reason}"
                            execution.task_success = False
                        break

                    # Continue to next step — don't abort the whole task
                    continue

                step = StepRecord(
                    step_number=step_num,
                    timestamp=time.time(),
                    action=action_name,
                    action_input=action_params,
                    reasoning=reasoning,
                    result=action_result.get("result", ""),
                    success=action_result.get("success", False),
                    screenshot_b64=action_result.get("screenshot"),
                    duration_seconds=time.time() - step_start,
                    json_parse_retries=parse_retries,
                )
                execution.steps.append(step)

                # Check if agent is stuck after each action
                stuck_reason = self._check_stuck(execution.steps)
                if stuck_reason:
                    if stuck_reason.startswith("__auto_done__:"):
                        answer = stuck_reason[len("__auto_done__:"):]
                        logger.info(f"Auto-rescued stuck action as done: {answer[:80]}...")
                        execution.final_result = answer
                        execution.task_success = True
                        execution.steps.append(StepRecord(
                            step_number=step_num + 1, timestamp=time.time(),
                            action="done", action_input={"result": answer, "success": True},
                            reasoning="Auto-rescued: model had the answer but repeated an action instead of calling done",
                            result=answer, success=True, duration_seconds=0,
                        ))
                        break
                    elif stuck_reason == "__retry_enter__":
                        # Click stuck loop — try pressing Enter as form submit fallback
                        logger.info(f"Click stuck at step {step_num} — auto-trying Enter key as form submit")
                        try:
                            enter_result = await session.press_key("Enter")
                            execution.steps.append(StepRecord(
                                step_number=step_num + 1, timestamp=time.time(),
                                action="press_key", action_input={"key": "Enter"},
                                reasoning="Auto-recovery: click stuck loop detected, trying Enter key as form submit",
                                result=enter_result.detail, success=enter_result.success,
                                screenshot_b64=enter_result.screenshot_b64,
                                duration_seconds=0,
                            ))
                            # Let the model see the result and continue
                            new_screenshot = enter_result.screenshot_b64
                            page_text = ""
                            try:
                                page_text = await session.get_page_text()
                            except Exception:
                                pass
                            messages.append({"role": "assistant", "content": raw_response})
                            feedback_msg = {
                                "role": "user",
                                "content": (
                                    f"Your repeated clicks at the same location were not working. "
                                    f"I pressed Enter for you as a form submit alternative.\n\n"
                                    f"PAGE TEXT (first {MAX_PAGE_TEXT_CHARS} chars):\n{page_text[:MAX_PAGE_TEXT_CHARS]}\n\n"
                                    "Here is the updated screenshot. Check if the form was submitted. "
                                    'If so, report the result with done {"result": "...", "success": true}. '
                                    "If not, try a different approach."
                                ),
                            }
                            if new_screenshot:
                                feedback_msg["images"] = [new_screenshot]
                            messages.append(feedback_msg)
                            continue  # let the model proceed
                        except Exception as e:
                            logger.warning(f"Enter key fallback failed: {e}")
                            execution.failure_reason = f"Click stuck and Enter fallback failed: {e}"
                            execution.final_result = f"Aborted: click stuck loop"
                            execution.task_success = False
                            break
                    else:
                        logger.warning(f"Early abort at step {step_num}: {stuck_reason}")
                        execution.failure_reason = stuck_reason
                        execution.final_result = f"Aborted: {stuck_reason}"
                        execution.task_success = False
                        break

                # Done?
                if action_name == "done":
                    self._current_phase = "done"
                    execution.final_result = action_params.get("result", "")
                    execution.task_success = action_params.get("success", False)
                    break

                # Append assistant response + action feedback for next turn
                messages.append({
                    "role": "assistant",
                    "content": raw_response,
                })

                # Build feedback message with new screenshot + DOM text
                new_screenshot = action_result.get("screenshot")
                page_text = ""
                try:
                    page_text = await session.get_page_text()
                except Exception:
                    pass
                page_text_snippet = page_text[:MAX_PAGE_TEXT_CHARS]

                # Get interactive elements for this turn
                try:
                    current_elements = await session.get_interactive_elements(MAX_INTERACTIVE_ELEMENTS)
                except Exception:
                    current_elements = []
                elements_text = _format_elements(current_elements)

                feedback_text = (
                    f"Action result: {action_result.get('result', 'Done')}\n\n"
                    f"PAGE TEXT (first {MAX_PAGE_TEXT_CHARS} chars):\n{page_text_snippet}\n\n"
                    f"ELEMENTS:\n{elements_text}\n\n"
                    "What is the next action?"
                )

                # ── Scroll boundary hint: tell the model it hit top/bottom ──
                if action_name == "scroll":
                    result_str = action_result.get("result", "")
                    pos_match = re.search(r"Position: (\d+)%", result_str)
                    if pos_match:
                        pct = int(pos_match.group(1))
                        if pct >= 95 and action_params.get("direction", "down") == "down":
                            feedback_text += (
                                "\n\n⚠ You have reached the BOTTOM of the page. "
                                "Do NOT scroll down again. Instead try: "
                                'read_page_text to get more text from the page, '
                                "scroll up, or call done with your best answer."
                            )
                        elif pct <= 5 and action_params.get("direction") == "up":
                            feedback_text += (
                                "\n\n⚠ You have reached the TOP of the page. "
                                "Do NOT scroll up again. Instead try: "
                                'read_page_text to get more text from the page, '
                                "scroll down, or call done with your best answer."
                            )

                # ── Recovery nudge: if same action repeated, warn progressively ──
                if len(execution.steps) >= 2:
                    # Count how many times the same action+params has been repeated
                    repeat_count = 1
                    for prev_step in reversed(execution.steps[:-1]):
                        if prev_step.action == step.action and prev_step.action_input == step.action_input:
                            repeat_count += 1
                        else:
                            break

                    if repeat_count >= 2 and step.action not in ("done",):
                        if repeat_count >= 3 or (step.action == "find_text" and not step.action_input.get("query", "").strip()):
                            # 3+ repeats or empty find_text — force done
                            feedback_text += (
                                "\n\n🛑 CRITICAL: You have repeated the same action multiple times. "
                                "You MUST call done NOW with your best answer based on the page text shown above. "
                                'Use: done {"result": "your answer based on what you can see", "success": true}'
                            )
                        else:
                            feedback_text += (
                                f"\n\n⚠ WARNING: You just repeated '{step.action}' with the "
                                f"same parameters {repeat_count} times. You MUST choose a DIFFERENT action "
                                f"now. Consider: navigate, click, scroll, read_page_text, or done."
                            )

                feedback_msg = {"role": "user", "content": feedback_text}
                if new_screenshot:
                    feedback_msg["images"] = [new_screenshot]
                messages.append(feedback_msg)

            else:
                # max_steps exhausted
                self._current_phase = "done"
                execution.final_result = (
                    f"Step budget exhausted ({self.max_steps} steps). "
                    f"Last state: {execution.steps[-1].result if execution.steps else 'no actions taken'}"
                )
                execution.task_success = False

        except Exception as e:
            error_detail = f"{type(e).__name__}: {str(e)}" if str(e) else type(e).__name__
            logger.exception(f"Task execution failed: {error_detail}")
            execution.error = error_detail
            execution.final_result = f"Execution error: {error_detail}"
            execution.task_success = False
        finally:
            self._current_phase = "done"
            try:
                await session.stop()
            except Exception:
                pass
            execution.completed_at = time.time()

        # Local model — no token costs
        execution.total_cost_usd = 0.0
        return execution

    # ── Action dispatch ────────────────────────────────────────────────

    @staticmethod
    def _safe_int(val, default: int = 0) -> int:
        """Extract an integer from whatever the model sends (int, float, str, list)."""
        if isinstance(val, (int, float)):
            return int(val)
        if isinstance(val, str):
            # Strip non-numeric chars and parse
            cleaned = re.sub(r"[^\d.\-]", "", val)
            return int(float(cleaned)) if cleaned else default
        if isinstance(val, (list, tuple)) and val:
            return ComputerUseAgent._safe_int(val[0], default)
        return default

    def _xy(self, params: dict) -> tuple[int, int]:
        """Extract (x, y) coordinates from params, handling all model quirks."""
        return self._safe_int(params.get("x", 0)), self._safe_int(params.get("y", 0))

    async def _execute_action(self, session: BrowserSession, action: str, params: dict) -> dict:
        """Route an action to the browser session."""

        if action == "navigate":
            res = await session.navigate(params.get("url", "about:blank"))
            return {"success": res.success, "result": res.detail, "screenshot": res.screenshot_b64}

        if action == "click":
            x, y = self._xy(params)
            res = await session.click(x, y)
            return {"success": res.success, "result": res.detail, "screenshot": res.screenshot_b64}

        if action == "type_text":
            res = await session.type_text(params.get("text", ""))
            return {"success": res.success, "result": res.detail, "screenshot": res.screenshot_b64}

        if action == "click_and_type":
            # Composite action: click a form field, then type into it
            x, y = self._xy(params)
            text = params.get("text", "")
            click_res = await session.click(x, y)
            if not click_res.success:
                return {"success": False, "result": f"Click failed at ({x},{y}): {click_res.detail}", "screenshot": click_res.screenshot_b64}
            # Small delay for focus to settle
            await asyncio.sleep(0.3)
            # Clear existing content and type new text
            try:
                await session.page.keyboard.press("Control+a")
                await asyncio.sleep(0.1)
            except Exception:
                pass
            type_res = await session.type_text(text)
            return {"success": type_res.success, "result": f"Clicked ({x},{y}) and typed '{text}'", "screenshot": type_res.screenshot_b64}

        if action == "select_option":
            # Click a radio button, checkbox, or dropdown option
            x, y = self._xy(params)
            res = await session.click(x, y)
            detail = f"Selected option at ({x},{y})"
            if not res.success:
                detail = f"Click failed at ({x},{y}): {res.detail}"
            return {"success": res.success, "result": detail, "screenshot": res.screenshot_b64}

        if action == "press_key":
            res = await session.press_key(params.get("key", "Enter"))
            return {"success": res.success, "result": res.detail, "screenshot": res.screenshot_b64}

        if action == "scroll":
            res = await session.scroll(params.get("direction", "down"), self._safe_int(params.get("amount", 1), 1))
            return {"success": res.success, "result": res.detail, "screenshot": res.screenshot_b64}

        if action == "find_text":
            query = params.get("query", "").strip()
            if not query:
                return {"success": False, "result": "find_text requires a non-empty 'query' parameter, e.g. find_text {\"query\": \"population\"}. Try reading the page or using done instead.", "screenshot": None}
            res = await session.find_text(query)
            return {"success": res.success, "result": res.detail, "screenshot": res.screenshot_b64}

        if action == "read_page_text":
            text = await session.get_page_text()
            ss = await session.screenshot()
            truncated = text[:3000] + ("..." if len(text) > 3000 else "")
            return {"success": True, "result": f"Page text:\n{truncated}", "screenshot": ss}

        if action == "done":
            return {"success": params.get("success", False), "result": params.get("result", "Task completed"), "screenshot": None}

        return {"success": False, "result": f"Unknown action: {action}", "screenshot": None}
