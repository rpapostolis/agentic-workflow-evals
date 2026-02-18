"""
Browser automation tools using Playwright.

Provides a clean interface for the CU agent to interact with web pages:
screenshot, click, type, navigate, scroll, read text.
"""

import asyncio
import base64
import logging
from dataclasses import dataclass, field
from typing import Optional

from playwright.async_api import async_playwright, Browser, Page, Playwright

logger = logging.getLogger(__name__)


@dataclass
class ActionResult:
    """Result of a browser action."""
    success: bool
    action: str
    detail: str = ""
    screenshot_b64: Optional[str] = None
    error: Optional[str] = None


@dataclass
class BrowserSession:
    """Manages a single browser session for a task execution."""
    _playwright: Optional[Playwright] = field(default=None, repr=False)
    _browser: Optional[Browser] = field(default=None, repr=False)
    _page: Optional[Page] = field(default=None, repr=False)
    viewport_width: int = 1280
    viewport_height: int = 900
    headless: bool = True
    actions_log: list = field(default_factory=list)

    async def start(self) -> None:
        """Launch browser and create a new page."""
        self._playwright = await async_playwright().start()

        launch_args = [
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
        ]
        if not self.headless:
            # Position the test browser in the lower-right corner of the screen.
            # Only set position — let Playwright's viewport control the actual size
            # to avoid zoom/crop issues on HiDPI/Retina displays.
            screen_w, screen_h = 1920, 1080
            pos_x = max(0, screen_w - self.viewport_width - 40)
            pos_y = max(0, screen_h - self.viewport_height - 100)
            launch_args += [
                f"--window-position={pos_x},{pos_y}",
            ]

        self._browser = await self._playwright.chromium.launch(
            headless=self.headless,
            args=launch_args,
        )
        self._page = await self._browser.new_page(
            viewport={"width": self.viewport_width, "height": self.viewport_height},
            # Set US locale + timezone so sites don't show GDPR consent banners
            # (they only trigger for browsers that appear to be in the EU).
            locale="en-US",
            timezone_id="America/New_York",
        )

        # Pre-set consent state in localStorage/sessionStorage before any page loads.
        # Many CMPs (Cookiebot, OneTrust, generic) check these keys and skip the banner.
        await self._page.add_init_script("""
            try {
                const ts = new Date().toISOString();
                localStorage.setItem('cookieconsent_status',        'dismiss');
                localStorage.setItem('OptanonAlertBoxClosed',       ts);
                localStorage.setItem('OptanonConsent',              'isGpcEnabled=0&datestamp=' + ts + '&version=202501.2.0&browserGpcFlag=0&isIABGlobal=false&consentId=auto&interactionCount=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1');
                localStorage.setItem('CookieConsent',               '{stamp:"auto",necessary:true,preferences:true,statistics:true,marketing:true,ver:1}');
                localStorage.setItem('cookie_consent',              '1');
                localStorage.setItem('gdpr_consent',                '1');
                localStorage.setItem('consent_given',               'true');
                localStorage.setItem('euconsent-v2',                'auto');
                sessionStorage.setItem('cookieconsent_status',      'dismiss');
            } catch(e) {}
        """)

        logger.info(f"Browser session started (headless={self.headless})")

    async def stop(self) -> None:
        """Close browser and cleanup."""
        if self._page:
            await self._page.close()
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        logger.info("Browser session stopped")

    async def screenshot(self) -> str:
        """Take a screenshot and return base64-encoded PNG.

        NOTE: qwen2.5vl's vision encoder expects specific image dimensions
        that match the viewport.  Do NOT resize or re-encode (JPEG, scaling)
        — the ViT patch grid will crash with a tensor mismatch (GGML_ASSERT).
        Optimise inference via num_ctx / num_predict / keep_images instead.
        """
        assert self._page, "Browser not started"
        img_bytes = await self._page.screenshot(type="png")
        return base64.b64encode(img_bytes).decode("utf-8")

    async def _dismiss_consent_dialogs(self) -> bool:
        """Auto-dismiss cookie/privacy consent dialogs after page load.

        Tries common CMP button patterns (OneTrust, Cookiebot, Google, generic).
        Prefers 'Reject All' to minimise cookie acceptance; falls back to 'Accept'
        buttons if no reject option is found. Silent if no dialog is present.
        Returns True if a button was clicked.
        """
        assert self._page, "Browser not started"
        try:
            clicked = await self._page.evaluate("""() => {
                // Ordered by preference: reject first, accept as last resort.
                // Each entry is [cssSelector, requiredTextSubstring_or_null].
                // null means match any visible element with that selector.
                const candidates = [
                    // ── OneTrust ──────────────────────────────────────────────
                    ['#onetrust-reject-all-handler',         null],
                    ['#onetrust-accept-btn-handler',         null],
                    // ── Cookiebot ─────────────────────────────────────────────
                    ['#CybotCookiebotDialogBodyButtonDecline', null],
                    ['#CybotCookiebotDialogBodyLevelButtonAcceptSelected', null],
                    // ── Google consent overlay ────────────────────────────────
                    ['[aria-label="Reject all"]',            null],
                    ['[aria-label="Accept all"]',            null],
                    ['form[action*="consent"] button',       'reject'],
                    ['form[action*="consent"] button',       'accept'],
                    // ── TrustArc / generic ────────────────────────────────────
                    ['[data-testid*="reject" i]',            null],
                    ['[data-testid*="accept" i]',            null],
                    ['button[id*="reject" i]',               null],
                    ['button[id*="decline" i]',              null],
                    ['button[class*="reject" i]',            null],
                    ['button[class*="decline" i]',           null],
                    // ── Text-match fallbacks (buttons only) ───────────────────
                    ['button', 'reject all'],
                    ['button', 'decline all'],
                    ['button', 'refuse all'],
                    ['button', 'decline'],
                    ['button', 'reject'],
                    ['button', 'accept all'],
                    ['button', 'accept cookies'],
                    ['button', 'i agree'],
                    ['button', 'agree'],
                    ['button', 'got it'],
                    ['button', 'ok'],
                    // ── Close/dismiss as absolute last resort ─────────────────
                    ['[aria-label="Close"]',                 null],
                    ['button[aria-label*="close" i]',        null],
                ];

                for (const [sel, text] of candidates) {
                    let els;
                    try { els = Array.from(document.querySelectorAll(sel)); }
                    catch(e) { continue; }

                    for (const el of els) {
                        // Must be visible (has layout box, not hidden)
                        if (!el.offsetParent && el.tagName !== 'BUTTON') continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width < 2 || rect.height < 2) continue;

                        if (text === null ||
                            el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
                            el.click();
                            return true;
                        }
                    }
                }
                return false;
            }""")
            if clicked:
                logger.info("Auto-dismissed consent dialog")
                await self._page.wait_for_timeout(600)  # let dialog animate out
            return clicked
        except Exception as e:
            logger.debug(f"Consent dismiss check failed (non-fatal): {e}")
            return False

    async def navigate(self, url: str) -> ActionResult:
        """Navigate to a URL."""
        assert self._page, "Browser not started"
        try:
            response = await self._page.goto(url, wait_until="load", timeout=20000)
            # Extra wait for JS-heavy pages to finish rendering
            await self._page.wait_for_timeout(1000)
            # Auto-dismiss any cookie/privacy consent dialog before the model sees the page
            await self._dismiss_consent_dialogs()
            status = response.status if response else "unknown"
            screenshot = await self.screenshot()
            result = ActionResult(
                success=True,
                action="navigate",
                detail=f"Navigated to {url} (status: {status})",
                screenshot_b64=screenshot,
            )
            self.actions_log.append(result)
            return result
        except Exception as e:
            result = ActionResult(
                success=False, action="navigate", detail=url, error=str(e)
            )
            self.actions_log.append(result)
            return result

    async def click(self, x: int, y: int) -> ActionResult:
        """Click at coordinates (x, y)."""
        assert self._page, "Browser not started"
        try:
            await self._page.mouse.click(x, y)
            await self._page.wait_for_timeout(500)  # Brief pause for UI response
            screenshot = await self.screenshot()
            result = ActionResult(
                success=True,
                action="click",
                detail=f"Clicked at ({x}, {y})",
                screenshot_b64=screenshot,
            )
            self.actions_log.append(result)
            return result
        except Exception as e:
            result = ActionResult(
                success=False, action="click", detail=f"({x}, {y})", error=str(e)
            )
            self.actions_log.append(result)
            return result

    async def type_text(self, text: str) -> ActionResult:
        """Type text using keyboard."""
        assert self._page, "Browser not started"
        try:
            await self._page.keyboard.type(text, delay=30)
            await self._page.wait_for_timeout(300)
            screenshot = await self.screenshot()
            result = ActionResult(
                success=True,
                action="type",
                detail=f"Typed: {text[:50]}{'...' if len(text) > 50 else ''}",
                screenshot_b64=screenshot,
            )
            self.actions_log.append(result)
            return result
        except Exception as e:
            result = ActionResult(
                success=False, action="type", detail=text[:50], error=str(e)
            )
            self.actions_log.append(result)
            return result

    async def press_key(self, key: str) -> ActionResult:
        """Press a keyboard key (Enter, Tab, Escape, etc.)."""
        assert self._page, "Browser not started"
        try:
            await self._page.keyboard.press(key)
            await self._page.wait_for_timeout(300)
            screenshot = await self.screenshot()
            result = ActionResult(
                success=True,
                action="key",
                detail=f"Pressed: {key}",
                screenshot_b64=screenshot,
            )
            self.actions_log.append(result)
            return result
        except Exception as e:
            result = ActionResult(
                success=False, action="key", detail=key, error=str(e)
            )
            self.actions_log.append(result)
            return result

    async def scroll(self, direction: str = "down", amount: int = 1) -> ActionResult:
        """Scroll the page. Direction: 'up' or 'down'. amount=1 scrolls one full viewport minus overlap."""
        assert self._page, "Browser not started"
        try:
            # One "tick" = viewport height minus 15% overlap so content isn't lost
            overlap = int(self.viewport_height * 0.15)
            pixels_per_tick = self.viewport_height - overlap
            delta = amount * pixels_per_tick if direction == "down" else -(amount * pixels_per_tick)
            await self._page.mouse.wheel(0, delta)
            await self._page.wait_for_timeout(500)

            # Report scroll position so the model knows where it is
            scroll_info = await self._page.evaluate("""() => {
                const scrollY = window.scrollY;
                const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                const pct = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 0;
                return { scrollY: Math.round(scrollY), maxScroll: Math.round(maxScroll), pct };
            }""")

            screenshot = await self.screenshot()
            position_info = (
                f"Scrolled {direction} by {amount} ticks ({amount * pixels_per_tick}px). "
                f"Position: {scroll_info['pct']}% "
                f"({scroll_info['scrollY']}/{scroll_info['maxScroll']}px)"
            )
            result = ActionResult(
                success=True,
                action="scroll",
                detail=position_info,
                screenshot_b64=screenshot,
            )
            self.actions_log.append(result)
            return result
        except Exception as e:
            result = ActionResult(
                success=False, action="scroll", detail=direction, error=str(e)
            )
            self.actions_log.append(result)
            return result

    async def find_text(self, query: str) -> ActionResult:
        """Search for text on the page, scroll to it, and return surrounding context."""
        assert self._page, "Browser not started"
        try:
            result = await self._page.evaluate("""(query) => {
                // Search through all text nodes for the query (case-insensitive)
                const walker = document.createTreeWalker(
                    document.body, NodeFilter.SHOW_TEXT, null
                );
                const q = query.toLowerCase();
                let node;
                while (node = walker.nextNode()) {
                    if (node.textContent.toLowerCase().includes(q)) {
                        const el = node.parentElement;
                        if (el) {
                            el.scrollIntoView({ behavior: 'instant', block: 'center' });
                            // Grab surrounding context — walk up to find a container with enough text
                            let ctx = el;
                            for (let i = 0; i < 5; i++) {
                                if (ctx.parentElement && ctx.innerText.length < 500) {
                                    ctx = ctx.parentElement;
                                } else break;
                            }
                            const text = ctx.innerText.substring(0, 1500);
                            const rect = el.getBoundingClientRect();
                            return {
                                found: true,
                                context: text,
                                x: Math.round(rect.left + rect.width / 2),
                                y: Math.round(rect.top + rect.height / 2)
                            };
                        }
                    }
                }
                return { found: false, context: '', x: 0, y: 0 };
            }""", query)

            await self._page.wait_for_timeout(300)
            screenshot = await self.screenshot()

            if result['found']:
                detail = (
                    f"Found '{query}' at ({result['x']}, {result['y']}). "
                    f"Context:\n{result['context']}"
                )
                return ActionResult(
                    success=True, action="find_text", detail=detail,
                    screenshot_b64=screenshot,
                )
            else:
                return ActionResult(
                    success=False, action="find_text",
                    detail=f"Text '{query}' not found on this page.",
                    screenshot_b64=screenshot,
                )
        except Exception as e:
            return ActionResult(
                success=False, action="find_text", detail=query, error=str(e),
            )

    async def get_interactive_elements(self, max_elements: int = 15) -> list[dict]:
        """Extract interactive elements (inputs, buttons, links) with bounding boxes.

        Returns a list of dicts with keys: tag, type, text, placeholder, x, y, w, h.
        Coordinates are absolute pixels matching the viewport — ready for click().
        """
        assert self._page, "Browser not started"
        try:
            elements = await self._page.evaluate("""(max) => {
                const results = [];
                // Selectors ordered by likely usefulness for browser automation
                const sel = 'input, textarea, select, button, [role="button"], [role="search"], a[href]';
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    if (results.length >= max) break;
                    const rect = el.getBoundingClientRect();
                    // Skip invisible / off-screen elements
                    if (rect.width < 5 || rect.height < 5) continue;
                    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                    if (rect.right < 0 || rect.left > window.innerWidth) continue;
                    const tag = el.tagName.toLowerCase();
                    let text = '';
                    if (tag === 'input' || tag === 'textarea') {
                        text = el.value || '';
                    } else if (tag === 'select') {
                        text = el.options[el.selectedIndex]?.text || '';
                    } else {
                        text = (el.innerText || el.textContent || '').trim().substring(0, 60);
                    }
                    results.push({
                        tag: tag,
                        type: el.type || '',
                        text: text,
                        placeholder: el.placeholder || el.getAttribute('aria-label') || '',
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2),
                        w: Math.round(rect.width),
                        h: Math.round(rect.height),
                    });
                }
                return results;
            }""", max_elements)
            return elements or []
        except Exception as e:
            logger.warning(f"Failed to extract interactive elements: {e}")
            return []

    async def get_page_text(self) -> str:
        """Extract visible text content from the current page."""
        assert self._page, "Browser not started"
        try:
            text = await self._page.evaluate("() => document.body.innerText")
            return text or ""
        except Exception:
            return ""

