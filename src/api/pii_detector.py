"""
PII Detection System for Production Traces

Detects and redacts personally identifiable information (PII) from agent traces
before they are stored or converted into test cases.
"""

import re
import json
import copy
from typing import List, Dict, Tuple, Optional

# Keys whose values are base64 image blobs — scanning them for PII is
# pointless (guaranteed false positives) and expensive.
_BASE64_KEYS = frozenset({"screenshot_b64", "screenshot", "data", "image_data"})


class PIIDetector:
    """Detect and redact PII in production traces."""

    # Regex patterns for common PII types
    PATTERNS = {
        'email': r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',
        'ssn': r'\b\d{3}-\d{2}-\d{4}\b',
        'phone': r'\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b',
        'credit_card': r'\b(?:\d{4}[-\s]?){3}\d{4}\b',
        # API key: require a recognisable prefix (sk-, key-, AKIA, ghp_, etc.)
        # The old pattern (\b[A-Za-z0-9]{32,64}\b) matched base64 screenshot
        # data and random hashes — a guaranteed false positive on every CUA trace.
        'api_key': (
            r'\b(?:'
            r'sk-[A-Za-z0-9]{20,}'           # Anthropic / OpenAI style
            r'|AKIA[0-9A-Z]{16}'             # AWS access key
            r'|ghp_[A-Za-z0-9]{36}'          # GitHub PAT
            r'|glpat-[A-Za-z0-9\-]{20,}'     # GitLab PAT
            r'|xox[bpsa]-[A-Za-z0-9\-]+'     # Slack token
            r'|AIza[A-Za-z0-9_\-]{35}'       # Google API key
            r')\b'
        ),
        'url_with_token': r'https?://[^\s]+[\?&](?:token|key|api_key|auth|secret)=[A-Za-z0-9_-]+',
        # IPv4 — exclude private/loopback ranges (127.x, 10.x, 192.168.x, 0.0.0.0)
        # that appear constantly in dev tool_calls and server URLs.
        'ipv4': (
            r'\b(?!127\.)(?!10\.)(?!0\.0\.0\.0)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)'
            r'(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}'
            r'(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b'
        ),
    }

    # Default redaction replacements
    DEFAULT_REDACTIONS = {
        'email': '[EMAIL_REDACTED]',
        'ssn': '[SSN_REDACTED]',
        'phone': '[PHONE_REDACTED]',
        'credit_card': '[CC_REDACTED]',
        'api_key': '[API_KEY_REDACTED]',
        'url_with_token': '[URL_WITH_TOKEN_REDACTED]',
        'ipv4': '[IP_REDACTED]',
    }

    def scan(self, text: str) -> Tuple[bool, List[str]]:
        """
        Scan text for PII.

        Args:
            text: The text to scan for PII

        Returns:
            Tuple of (has_pii, [list of PII types found])
        """
        if not text:
            return False, []

        found_types = []
        for pii_type, pattern in self.PATTERNS.items():
            if re.search(pattern, text, re.IGNORECASE):
                found_types.append(pii_type)

        return len(found_types) > 0, found_types

    def redact(self, text: str, redaction_map: Optional[Dict[str, str]] = None) -> str:
        """
        Redact PII from text.

        Args:
            text: The text to redact
            redaction_map: Optional custom redaction replacements

        Returns:
            Text with PII redacted
        """
        if not text:
            return text

        redaction_map = redaction_map or self.DEFAULT_REDACTIONS
        result = text

        # Apply redactions in order of specificity (most specific first)
        # URL with tokens first (more specific than generic api_key)
        ordered_types = ['url_with_token', 'credit_card', 'ssn', 'email', 'phone', 'api_key', 'ipv4']

        for pii_type in ordered_types:
            if pii_type in self.PATTERNS:
                pattern = self.PATTERNS[pii_type]
                replacement = redaction_map.get(pii_type, '[REDACTED]')
                result = re.sub(pattern, replacement, result, flags=re.IGNORECASE)

        return result

    @staticmethod
    def _strip_base64(obj):
        """Return a shallow copy of *obj* with base64 image values replaced by a placeholder."""
        if not isinstance(obj, dict):
            return obj
        cleaned = {}
        for k, v in obj.items():
            if k in _BASE64_KEYS and isinstance(v, str) and len(v) > 256:
                cleaned[k] = "[base64_image]"
            elif isinstance(v, dict):
                cleaned[k] = PIIDetector._strip_base64(v)
            elif isinstance(v, list):
                cleaned[k] = [
                    PIIDetector._strip_base64(item) if isinstance(item, dict) else item
                    for item in v
                ]
            else:
                cleaned[k] = v
        return cleaned

    def scan_trace(self, trace_data: dict) -> dict:
        """
        Scan entire trace for PII (input, output, tool calls).

        Args:
            trace_data: Dictionary with 'input', 'output', optional 'tool_calls'

        Returns:
            Dictionary with:
                - pii_detected: bool
                - pii_flags: list of PII types found
                - pii_scan_completed: bool
                - pii_locations: dict mapping field names to PII types found
        """
        pii_flags_set = set()
        pii_locations = {}

        # Scan input
        input_text = trace_data.get('input', '')
        if input_text:
            has_pii, pii_types = self.scan(input_text)
            if has_pii:
                pii_flags_set.update(pii_types)
                pii_locations['input'] = pii_types

        # Scan output
        output_text = trace_data.get('output', '')
        if output_text:
            has_pii, pii_types = self.scan(output_text)
            if has_pii:
                pii_flags_set.update(pii_types)
                pii_locations['output'] = pii_types

        # Scan tool calls (if present)
        tool_calls = trace_data.get('tool_calls')
        if tool_calls:
            # Handle both JSON string and list
            if isinstance(tool_calls, str):
                try:
                    tool_calls = json.loads(tool_calls)
                except (json.JSONDecodeError, TypeError):
                    tool_calls = []

            if isinstance(tool_calls, list):
                for idx, tool_call in enumerate(tool_calls):
                    # Strip base64 image blobs before scanning — they are
                    # megabytes of random-looking alphanumeric data that
                    # match every "secret-like" pattern.
                    clean_call = self._strip_base64(tool_call) if isinstance(tool_call, dict) else tool_call
                    tool_str = json.dumps(clean_call) if isinstance(clean_call, dict) else str(clean_call)
                    has_pii, pii_types = self.scan(tool_str)
                    if has_pii:
                        pii_flags_set.update(pii_types)
                        pii_locations[f'tool_call_{idx}'] = pii_types

        pii_flags = sorted(list(pii_flags_set))

        return {
            'pii_detected': len(pii_flags) > 0,
            'pii_flags': pii_flags,
            'pii_scan_completed': True,
            'pii_locations': pii_locations
        }

    def redact_trace(self, trace_data: dict, redaction_map: Optional[Dict[str, str]] = None) -> dict:
        """
        Create a redacted copy of trace data.

        Args:
            trace_data: Dictionary with 'input', 'output', optional 'tool_calls'
            redaction_map: Optional custom redaction replacements

        Returns:
            New dictionary with PII redacted from all fields
        """
        redacted = trace_data.copy()

        # Redact input
        if 'input' in redacted:
            redacted['input'] = self.redact(redacted['input'], redaction_map)

        # Redact output
        if 'output' in redacted:
            redacted['output'] = self.redact(redacted['output'], redaction_map)

        # Redact tool calls
        if 'tool_calls' in redacted:
            tool_calls = redacted['tool_calls']

            # Handle JSON string
            if isinstance(tool_calls, str):
                try:
                    tool_calls = json.loads(tool_calls)
                except (json.JSONDecodeError, TypeError):
                    tool_calls = []

            # Redact each tool call
            if isinstance(tool_calls, list):
                redacted_calls = []
                for call in tool_calls:
                    if isinstance(call, dict):
                        # Redact values in the dictionary
                        redacted_call = {}
                        for key, value in call.items():
                            if isinstance(value, str):
                                redacted_call[key] = self.redact(value, redaction_map)
                            else:
                                redacted_call[key] = value
                        redacted_calls.append(redacted_call)
                    else:
                        redacted_calls.append(call)

                redacted['tool_calls'] = json.dumps(redacted_calls)

        return redacted


# Singleton instance
pii_detector = PIIDetector()
