"""
Computer Use Agent — Claude-powered browser automation.

Uses Anthropic's computer-use beta API with the computer_20250124 /
computer_20251124 tool to control a Playwright browser.  The agent loop
sends screenshots back as tool_results; Claude decides the next action.

No Ollama required.  Requires ANTHROPIC_API_KEY (or LLM_API_KEY).
"""

import asyncio
import logging
import re
import time
from typing import Optional

import anthropic

from .agent import TaskExecution, StepRecord, _clean_extracted_url
from .browser import BrowserSession

logger = logging.getLogger(__name__)

# ── Pricing table (per 1K tokens, USD) ─────────────────────────────────────

_PRICING: dict[str, dict] = {
    # Claude 4.6 Opus — $5/$25 per MTok (per docs 2026-02-18)
    "claude-opus-4-6":           {"input_per_1k": 0.005,   "output_per_1k": 0.025},
    # Claude 4.5 Opus — same pricing
    "claude-opus-4-5-20251101":  {"input_per_1k": 0.005,   "output_per_1k": 0.025},
    "claude-opus-4-5":           {"input_per_1k": 0.005,   "output_per_1k": 0.025},
    # Claude 4.6 Sonnet — $3/$15 per MTok
    "claude-sonnet-4-6":          {"input_per_1k": 0.003,  "output_per_1k": 0.015},
    # Claude 4.5 Sonnet — same pricing
    "claude-sonnet-4-5-20250929": {"input_per_1k": 0.003,  "output_per_1k": 0.015},
    "claude-sonnet-4-5":          {"input_per_1k": 0.003,  "output_per_1k": 0.015},
    # Claude 4.5 Haiku — $1/$5 per MTok
    "claude-haiku-4-5-20251001":  {"input_per_1k": 0.001,  "output_per_1k": 0.005},
    "claude-haiku-4-5":           {"input_per_1k": 0.001,  "output_per_1k": 0.005},
    # Legacy Claude 3.x
    "claude-sonnet-3-7-20250219": {"input_per_1k": 0.003,  "output_per_1k": 0.015},
    # Fallback
    "_default": {"input_per_1k": 0.003, "output_per_1k": 0.015},
}


def _get_tool_version(model: str) -> tuple[str, str]:
    """Return (computer_tool_type, beta_flag) for the given model string.

    Opus 4.5 and Opus 4.6 → computer_20251124 (supports zoom)
    All other supported models → computer_20250124
    """
    m = model.lower()
    if "opus-4-5" in m or "opus-4-6" in m or "opus-4.5" in m or "opus-4.6" in m:
        return "computer_20251124", "computer-use-2025-11-24"
    return "computer_20250124", "computer-use-2025-01-24"


def _get_pricing(model: str) -> dict:
    """Look up pricing for a model, falling back to prefix match then default."""
    if model in _PRICING:
        return _PRICING[model]
    # Try prefix match (e.g. "claude-sonnet-4-5" prefix matches "claude-sonnet-4-5-20250929")
    for key, val in _PRICING.items():
        if key != "_default" and model.startswith(key):
            return val
    return _PRICING["_default"]


# ── System prompt ────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You are a browser automation agent that EXECUTES actions — you never describe or plan actions in text.

You have three tools:
- `computer` — interact with the browser (screenshot, left_click, type, key, scroll, etc.)
- `navigate` — go to a URL (there is NO address bar; you MUST use this tool)
- `done` — call this ONLY when the task is fully complete, with the final answer

CRITICAL RULES:
1. ALWAYS respond with tool calls. NEVER reply with only text.
2. Use `left_click`, `type`, `key`, `scroll` via the computer tool to interact.
3. After every action you will receive an updated screenshot automatically.
4. If a cookie/privacy banner appears, dismiss it (Reject/Decline preferred).
5. Call `done` with the result once the task objective is met.
6. Be efficient — fewest steps possible.

Viewport: {width}x{height}px."""


# ── Agent ────────────────────────────────────────────────────────────────────

class ClaudeCUAAgent:
    """Claude-powered browser automation agent (Anthropic computer-use beta)."""

    def __init__(
        self,
        api_key: str,
        model: str = "claude-sonnet-4-5-20250929",
        max_steps: int = 15,
        viewport_width: int = 1280,
        viewport_height: int = 720,
        headless: bool = True,
        action_timeout: float = 60.0,
    ):
        self.api_key = api_key
        self.model = model
        self.max_steps = max_steps
        self.viewport_width = viewport_width
        self.viewport_height = viewport_height
        self.headless = headless
        self.action_timeout = action_timeout

        self._tool_type, self._beta_flag = _get_tool_version(model)

        # Progress tracking — readable by server.py /progress endpoint
        self._current_step: int = 0
        self._current_phase: str = "idle"
        self._current_step_started: float = 0.0

    # ── Tool definitions ────────────────────────────────────────────────────

    def _make_tools(self) -> list[dict]:
        """Return the tool definitions for this agent's API calls."""
        tools: list[dict] = [
            {
                "type": self._tool_type,
                "name": "computer",
                "display_width_px": self.viewport_width,
                "display_height_px": self.viewport_height,
            },
            {
                "name": "navigate",
                "description": (
                    "Navigate the browser to a URL. "
                    "Use this instead of clicking an address bar — there is none. "
                    "Always include the full URL with https:// or http://."
                ),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Full URL, e.g. https://example.com",
                        }
                    },
                    "required": ["url"],
                },
            },
            {
                "name": "done",
                "description": "Signal that the task is complete and return the final result.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "result": {
                            "type": "string",
                            "description": "The task answer or a summary of what was accomplished.",
                        },
                        "success": {
                            "type": "boolean",
                            "description": "True if the task was completed successfully.",
                        },
                    },
                    "required": ["result", "success"],
                },
            },
        ]
        return tools

    # ── Action execution ────────────────────────────────────────────────────

    async def _exec_computer_action(
        self,
        session: BrowserSession,
        action: str,
        action_input: dict,
    ) -> tuple[bool, str, Optional[str]]:
        """Execute a computer tool action.

        Returns (success, detail_message, screenshot_b64_or_None).
        Always tries to return a screenshot so Claude has visual feedback.
        """
        page = session._page
        assert page, "Browser not started"

        async def _ss() -> str:
            return await session.screenshot()

        try:
            # ── screenshot ──────────────────────────────────────────────────
            if action == "screenshot":
                ss = await _ss()
                return True, "Screenshot taken", ss

            # ── mouse_move ──────────────────────────────────────────────────
            elif action == "mouse_move":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                await page.mouse.move(x, y)
                ss = await _ss()
                return True, f"Moved mouse to ({x},{y})", ss

            # ── left_click ──────────────────────────────────────────────────
            elif action == "left_click":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                modifier = action_input.get("text", "")  # shift/ctrl/alt modifier
                if modifier:
                    await page.keyboard.down(modifier.capitalize())
                await page.mouse.click(x, y)
                if modifier:
                    await page.keyboard.up(modifier.capitalize())
                await page.wait_for_timeout(400)
                ss = await _ss()
                return True, f"Clicked ({x},{y})" + (f" +{modifier}" if modifier else ""), ss

            # ── right_click ─────────────────────────────────────────────────
            elif action == "right_click":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                await page.mouse.click(x, y, button="right")
                await page.wait_for_timeout(400)
                ss = await _ss()
                return True, f"Right-clicked ({x},{y})", ss

            # ── middle_click ────────────────────────────────────────────────
            elif action == "middle_click":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                await page.mouse.click(x, y, button="middle")
                await page.wait_for_timeout(300)
                ss = await _ss()
                return True, f"Middle-clicked ({x},{y})", ss

            # ── double_click ────────────────────────────────────────────────
            elif action == "double_click":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                await page.mouse.dblclick(x, y)
                await page.wait_for_timeout(400)
                ss = await _ss()
                return True, f"Double-clicked ({x},{y})", ss

            # ── triple_click ────────────────────────────────────────────────
            elif action == "triple_click":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                await page.mouse.click(x, y, click_count=3)
                await page.wait_for_timeout(300)
                ss = await _ss()
                return True, f"Triple-clicked ({x},{y})", ss

            # ── type ────────────────────────────────────────────────────────
            elif action == "type":
                text = action_input.get("text", "")
                await page.keyboard.type(text, delay=20)
                await page.wait_for_timeout(200)
                ss = await _ss()
                return True, f"Typed: {text[:60]}{'...' if len(text) > 60 else ''}", ss

            # ── key ─────────────────────────────────────────────────────────
            elif action == "key":
                key_str = action_input.get("text", "")
                # Claude uses X11-style key names; map common ones to Playwright
                _key_map = {
                    "Return":    "Enter",
                    "BackSpace":  "Backspace",
                    "super":     "Meta",
                    "ctrl":      "Control",
                    "alt":       "Alt",
                }
                # Handle combos like "ctrl+c" → "Control+c"
                parts = key_str.split("+")
                mapped = "+".join(_key_map.get(p, p) for p in parts)
                await page.keyboard.press(mapped)
                await page.wait_for_timeout(300)
                ss = await _ss()
                return True, f"Pressed key: {mapped}", ss

            # ── scroll ──────────────────────────────────────────────────────
            elif action == "scroll":
                coord = action_input.get(
                    "coordinate", [self.viewport_width // 2, self.viewport_height // 2]
                )
                cx, cy = int(coord[0]), int(coord[1])
                direction = action_input.get("scroll_direction", "down")
                amount = int(action_input.get("scroll_amount", 3))
                modifier = action_input.get("text", "")

                px = amount * 120  # pixels per scroll unit
                dx, dy = 0, 0
                if direction == "down":    dy = px
                elif direction == "up":    dy = -px
                elif direction == "right": dx = px
                elif direction == "left":  dx = -px

                if modifier:
                    await page.keyboard.down(modifier.capitalize())
                await page.mouse.move(cx, cy)
                await page.mouse.wheel(dx, dy)
                if modifier:
                    await page.keyboard.up(modifier.capitalize())
                await page.wait_for_timeout(400)
                ss = await _ss()
                return True, f"Scrolled {direction} {amount}x at ({cx},{cy})", ss

            # ── left_click_drag ─────────────────────────────────────────────
            elif action == "left_click_drag":
                start = action_input.get("start_coordinate", [0, 0])
                end = action_input.get("coordinate", [0, 0])
                sx, sy = int(start[0]), int(start[1])
                ex, ey = int(end[0]), int(end[1])
                await page.mouse.move(sx, sy)
                await page.mouse.down()
                await asyncio.sleep(0.1)
                await page.mouse.move(ex, ey)
                await asyncio.sleep(0.1)
                await page.mouse.up()
                await page.wait_for_timeout(400)
                ss = await _ss()
                return True, f"Dragged ({sx},{sy}) → ({ex},{ey})", ss

            # ── left_mouse_down / left_mouse_up ─────────────────────────────
            elif action == "left_mouse_down":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                await page.mouse.move(x, y)
                await page.mouse.down()
                ss = await _ss()
                return True, f"Mouse down at ({x},{y})", ss

            elif action == "left_mouse_up":
                coord = action_input.get("coordinate", [0, 0])
                x, y = int(coord[0]), int(coord[1])
                await page.mouse.move(x, y)
                await page.mouse.up()
                ss = await _ss()
                return True, f"Mouse up at ({x},{y})", ss

            # ── hold_key ────────────────────────────────────────────────────
            elif action == "hold_key":
                key_str = action_input.get("text", "")
                duration = float(action_input.get("duration", 0.5))
                await page.keyboard.down(key_str)
                await asyncio.sleep(min(duration, 3.0))
                await page.keyboard.up(key_str)
                ss = await _ss()
                return True, f"Held {key_str} for {duration}s", ss

            # ── wait ────────────────────────────────────────────────────────
            elif action == "wait":
                duration = float(action_input.get("duration", 1.0))
                await asyncio.sleep(min(duration, 5.0))
                ss = await _ss()
                return True, f"Waited {duration}s", ss

            # ── zoom (computer_20251124 only) ────────────────────────────────
            elif action == "zoom":
                # Zoom is a vision-level operation; we just take a screenshot here.
                # In a real X11 environment you'd crop/upscale; for Playwright it's
                # good enough since Playwright already renders at full resolution.
                ss = await _ss()
                region = action_input.get("region", [0, 0, self.viewport_width, self.viewport_height])
                return True, f"Zoom of region {region}", ss

            # ── cursor_position ─────────────────────────────────────────────
            elif action == "cursor_position":
                ss = await _ss()
                return True, "Cursor position requested", ss

            else:
                ss = await _ss()
                return False, f"Unsupported computer action: {action}", ss

        except Exception as exc:
            logger.warning(f"Computer action '{action}' failed: {exc}")
            try:
                ss = await _ss()
            except Exception:
                ss = None
            return False, f"Action error: {exc}", ss

    # ── Helpers: build tool_result content blocks ───────────────────────────

    @staticmethod
    def _image_result(ss_b64: str) -> list[dict]:
        return [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": ss_b64,
                },
            }
        ]

    @staticmethod
    def _text_result(text: str) -> list[dict]:
        return [{"type": "text", "text": text}]

    # ── Main execution loop ──────────────────────────────────────────────────

    async def execute_task(
        self,
        task_input: str,
        session_tracker=None,
        cancel_check=None,
        custom_system_prompt: str | None = None,
    ) -> TaskExecution:
        """Execute a browser task using Claude's computer-use API.

        Args:
            task_input: Natural-language task description (may contain a URL).
            session_tracker: Optional (dict, key) for external cancellation.
            cancel_check: Optional callable → True if task should abort.
            custom_system_prompt: Optional prefix added to the built-in prompt.
        """
        execution = TaskExecution(task_input=task_input, started_at=time.time())

        session = BrowserSession(
            viewport_width=self.viewport_width,
            viewport_height=self.viewport_height,
            headless=self.headless,
        )

        # Build system prompt
        base_sys = _SYSTEM_PROMPT.format(
            width=self.viewport_width, height=self.viewport_height
        )
        if custom_system_prompt and custom_system_prompt.strip():
            system_prompt = (
                f"{custom_system_prompt.strip()}\n\n"
                f"--- BROWSER AUTOMATION INSTRUCTIONS ---\n\n"
                f"{base_sys}"
            )
            logger.info(
                "Using custom system prompt (%d chars) + built-in prompt",
                len(custom_system_prompt),
            )
        else:
            system_prompt = base_sys

        self._current_step = 0
        self._current_phase = "starting"
        self._current_step_started = 0.0

        def _is_cancelled() -> bool:
            return cancel_check() if cancel_check else False

        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        tools = self._make_tools()

        total_tokens_in = 0
        total_tokens_out = 0
        global_step = 0  # running action counter across all API calls
        task_done = False

        try:
            await session.start()

            if session_tracker:
                tracker_dict, tracker_key = session_tracker
                tracker_dict[tracker_key] = session

            # ── Auto-navigate to any URL in the task ─────────────────────
            url_match = re.search(r"https?://[^\s'\"<>]+", task_input)
            if url_match:
                auto_url = _clean_extracted_url(url_match.group(0))
                logger.info(f"Auto-navigating to URL in task: {auto_url}")
                nav_res = await session.navigate(auto_url)
                if nav_res.success:
                    global_step += 1
                    execution.steps.append(
                        StepRecord(
                            step_number=global_step,
                            timestamp=time.time(),
                            action="navigate",
                            action_input={"url": auto_url},
                            reasoning="Auto-navigated to URL found in task input",
                            result=nav_res.detail,
                            success=True,
                            screenshot_b64=nav_res.screenshot_b64,
                        )
                    )

            # ── Initial screenshot for first user message ─────────────────
            initial_ss = await session.screenshot()

            # Seed the conversation: task + initial screenshot
            messages: list[dict] = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"Task: {task_input}\n\n"
                                "Above is the current browser screenshot. "
                                "Complete the task step by step. "
                                "You MUST use the computer, navigate, and done tools — "
                                "do NOT describe actions in text. Execute them."
                            ),
                        },
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": initial_ss,
                            },
                        },
                    ],
                }
            ]

            # ── Agent loop ────────────────────────────────────────────────
            for iteration in range(self.max_steps):
                if _is_cancelled():
                    execution.final_result = "Task cancelled"
                    execution.task_success = False
                    break

                self._current_step = global_step + 1
                self._current_step_started = time.time()
                self._current_phase = "thinking"

                # ── Claude API call ───────────────────────────────────────
                try:
                    response = await asyncio.wait_for(
                        client.beta.messages.create(
                            model=self.model,
                            max_tokens=4096,
                            system=system_prompt,
                            tools=tools,
                            messages=messages,
                            betas=[self._beta_flag],
                        ),
                        timeout=max(self.action_timeout * 2, 120.0),
                    )
                except asyncio.TimeoutError:
                    logger.warning(f"Claude API timed out at iteration {iteration + 1}")
                    execution.failure_reason = "Claude API call timed out"
                    execution.final_result = "Aborted: API timeout"
                    execution.task_success = False
                    break
                except anthropic.APIStatusError as exc:
                    logger.error(f"Claude API error {exc.status_code}: {exc.message}")
                    execution.error = f"APIStatusError {exc.status_code}: {exc.message}"
                    execution.final_result = f"API error: {exc.message}"
                    execution.task_success = False
                    break
                except Exception as exc:
                    logger.error(f"Claude API unexpected error: {exc}")
                    execution.error = str(exc)
                    execution.final_result = f"API error: {exc}"
                    execution.task_success = False
                    break

                # Track token usage
                if hasattr(response, "usage"):
                    total_tokens_in += getattr(response.usage, "input_tokens", 0)
                    total_tokens_out += getattr(response.usage, "output_tokens", 0)

                # Append Claude's response to conversation history
                messages.append({"role": "assistant", "content": response.content})

                # ── Check for task completion (no tool_use = natural stop) ─
                tool_use_blocks = [b for b in response.content if b.type == "tool_use"]

                if not tool_use_blocks:
                    # Claude replied with text only — no tool invocations.
                    text_blocks = [
                        b for b in response.content if hasattr(b, "text") and b.text
                    ]
                    final_text = " ".join(b.text for b in text_blocks).strip()

                    # If this is iteration 0 (first turn) and the task is clearly not
                    # done, Claude is probably "planning" instead of acting.  Re-prompt
                    # it to use the tools rather than exiting the loop.
                    if iteration < 2 and final_text and "done" not in final_text.lower()[:40]:
                        logger.warning(
                            f"Claude replied with text instead of tools at iteration "
                            f"{iteration + 1} — re-prompting: {final_text[:80]!r}"
                        )
                        messages.append({
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": (
                                        "You responded with text instead of using a tool. "
                                        "Do NOT describe actions — execute them now. "
                                        "Use the `computer` tool (e.g. left_click, type, screenshot) "
                                        "or the `navigate` tool to interact with the browser. "
                                        "Use the `done` tool only when the task is fully complete."
                                    ),
                                },
                            ],
                        })
                        continue  # re-enter loop with the corrective prompt

                    # Otherwise treat it as a genuine completion
                    execution.final_result = final_text or "Task completed"
                    execution.task_success = True
                    task_done = True
                    logger.info(
                        f"Claude CUA finished at iteration {iteration + 1}: "
                        f"{final_text[:80]!r}"
                    )
                    break

                # ── Execute each tool_use block ───────────────────────────
                self._current_phase = "acting"
                tool_results: list[dict] = []
                step_start = time.time()

                for block in tool_use_blocks:
                    if _is_cancelled():
                        execution.final_result = "Task cancelled"
                        execution.task_success = False
                        task_done = True
                        break

                    tool_name = block.name
                    tool_input: dict = block.input if hasattr(block, "input") else {}
                    tool_id: str = block.id
                    action_start = time.time()

                    global_step += 1
                    self._current_step = global_step

                    try:
                        # ── computer tool ─────────────────────────────────
                        if tool_name == "computer":
                            action = tool_input.get("action", "screenshot")
                            success, detail, ss_b64 = await asyncio.wait_for(
                                self._exec_computer_action(session, action, tool_input),
                                timeout=self.action_timeout,
                            )
                            execution.steps.append(
                                StepRecord(
                                    step_number=global_step,
                                    timestamp=time.time(),
                                    action=action,
                                    action_input=tool_input,
                                    reasoning="",
                                    result=detail,
                                    success=success,
                                    screenshot_b64=ss_b64,
                                    duration_seconds=time.time() - action_start,
                                )
                            )
                            content = (
                                self._image_result(ss_b64) if ss_b64
                                else self._text_result(detail)
                            )
                            tool_results.append(
                                {"type": "tool_result", "tool_use_id": tool_id, "content": content}
                            )

                        # ── navigate tool ─────────────────────────────────
                        elif tool_name == "navigate":
                            url = tool_input.get("url", "")
                            nav_res = await asyncio.wait_for(
                                session.navigate(url),
                                timeout=self.action_timeout,
                            )
                            execution.steps.append(
                                StepRecord(
                                    step_number=global_step,
                                    timestamp=time.time(),
                                    action="navigate",
                                    action_input={"url": url},
                                    reasoning="",
                                    result=nav_res.detail,
                                    success=nav_res.success,
                                    screenshot_b64=nav_res.screenshot_b64,
                                    duration_seconds=time.time() - action_start,
                                )
                            )
                            content = (
                                self._image_result(nav_res.screenshot_b64)
                                if nav_res.screenshot_b64
                                else self._text_result(nav_res.detail)
                            )
                            tool_results.append(
                                {"type": "tool_result", "tool_use_id": tool_id, "content": content}
                            )

                        # ── done tool ─────────────────────────────────────
                        elif tool_name == "done":
                            result = tool_input.get("result", "Task completed")
                            success_flag = bool(tool_input.get("success", True))
                            execution.final_result = result
                            execution.task_success = success_flag
                            task_done = True
                            execution.steps.append(
                                StepRecord(
                                    step_number=global_step,
                                    timestamp=time.time(),
                                    action="done",
                                    action_input=tool_input,
                                    reasoning="",
                                    result=result,
                                    success=success_flag,
                                    duration_seconds=time.time() - action_start,
                                )
                            )
                            tool_results.append(
                                {
                                    "type": "tool_result",
                                    "tool_use_id": tool_id,
                                    "content": self._text_result("Task completion acknowledged."),
                                }
                            )
                            logger.info(
                                f"Claude CUA done tool at step {global_step}: "
                                f"success={success_flag}, result={result[:80]!r}"
                            )

                        else:
                            logger.warning(f"Unknown tool call from Claude: {tool_name}")
                            tool_results.append(
                                {
                                    "type": "tool_result",
                                    "tool_use_id": tool_id,
                                    "content": self._text_result(
                                        f"Unknown tool '{tool_name}'. Use computer, navigate, or done."
                                    ),
                                    "is_error": True,
                                }
                            )

                    except asyncio.TimeoutError:
                        logger.warning(f"Tool '{tool_name}' timed out after {self.action_timeout}s")
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": self._text_result(
                                    f"Error: action timed out after {self.action_timeout}s"
                                ),
                                "is_error": True,
                            }
                        )
                    except Exception as exc:
                        logger.warning(f"Tool '{tool_name}' raised: {exc}")
                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": self._text_result(f"Error: {exc}"),
                                "is_error": True,
                            }
                        )

                if task_done:
                    break

                # Add all tool results to conversation for next API call
                messages.append({"role": "user", "content": tool_results})

            else:
                # Exhausted max_steps iterations without `done` or natural stop
                last_result = execution.steps[-1].result if execution.steps else "no steps"
                execution.final_result = (
                    f"Step budget exhausted ({self.max_steps} iterations). "
                    f"Last: {last_result}"
                )
                execution.task_success = False

        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
            logger.exception(f"Task execution failed: {detail}")
            execution.error = detail
            execution.final_result = f"Execution error: {detail}"
            execution.task_success = False

        finally:
            self._current_phase = "done"
            try:
                await session.stop()
            except Exception:
                pass
            execution.completed_at = time.time()

        # ── Token costs ───────────────────────────────────────────────────
        execution.total_tokens_in = total_tokens_in
        execution.total_tokens_out = total_tokens_out
        pricing = _get_pricing(self.model)
        execution.total_cost_usd = (
            total_tokens_in / 1000 * pricing["input_per_1k"]
            + total_tokens_out / 1000 * pricing["output_per_1k"]
        )

        logger.info(
            f"Claude CUA task complete: success={execution.task_success}, "
            f"steps={execution.step_count}, "
            f"duration={execution.duration_seconds:.1f}s, "
            f"tokens={total_tokens_in}in/{total_tokens_out}out, "
            f"cost=${execution.total_cost_usd:.4f}"
        )
        return execution
