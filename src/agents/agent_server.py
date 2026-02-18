"""
Standalone Calendar Agent — fully local, no cloud dependencies.

A minimal FastAPI server providing an LLM-powered calendar scheduling agent
using a local Ollama (or any OpenAI-compatible) endpoint via MCP tools.
"""

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from openai import AsyncOpenAI
from pydantic import BaseModel

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ============================================================================
# Request/Response Models
# ============================================================================

class InvokeRequest(BaseModel):
    """Request model for agent invocation."""
    dataset_id: str
    test_case_id: str
    agent_id: str
    evaluation_run_id: str
    input: str
    system_prompt: Optional[str] = None


class ToolArgument(BaseModel):
    """Tool argument with name and value."""
    name: str
    value: Any


class ToolCall(BaseModel):
    """Tool call record."""
    name: str
    arguments: List[ToolArgument]
    response: Optional[Dict[str, Any]] = None  # MCP tool response


class InvokeResponse(BaseModel):
    """Response from agent invocation."""
    response: str
    tool_calls: List[ToolCall]


# ============================================================================
# Calendar Agent
# ============================================================================

class CalendarAgent:
    """OpenAI-compatible LLM-powered calendar scheduling agent (local)."""

    def __init__(self, mcp_server_url: Optional[str] = None):
        # Initialize OpenAI-compatible client pointing to local LLM
        base_url = os.getenv("AGENT_LLM_BASE_URL") or os.getenv("LLM_BASE_URL") or "http://localhost:11434/v1"
        # Key resolution: AGENT_LLM_API_KEY → LLM_API_KEY → ANTHROPIC_API_KEY → "ollama" (no-auth)
        api_key = os.getenv("AGENT_LLM_API_KEY") or os.getenv("LLM_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or "ollama"

        logger.info(f"Using local LLM at {base_url}")
        self.client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
        )

        self.deployment = os.getenv("AGENT_LLM_MODEL", os.getenv("LLM_MODEL", "qwen3-coder:latest"))
        self._supports_tools: Optional[bool] = None  # Auto-detected on first call

        # MCP server configuration
        self.mcp_server_url = mcp_server_url or os.getenv("MCP_SERVER_URL")
        self.mcp_session: Optional[ClientSession] = None
        self.mcp_connected = False
        self._mcp_read = None
        self._mcp_write = None
        self._mcp_context = None
        self._get_session_id = None

        # Tools will be populated from MCP server
        self.tools = []

        # Correlation headers for MCP tool calls
        self.correlation_headers: Dict[str, str] = {}

    async def connect_mcp(self):
        """Connect to MCP server over HTTP with streamable transport."""
        await self.connect_mcp_with_headers()

    async def connect_mcp_with_headers(self, headers: Optional[Dict[str, str]] = None):
        """Connect to MCP server with optional correlation headers."""
        if not self.mcp_server_url:
            logger.warning("No MCP server URL configured - agent will not have any tools available")
            logger.warning("Set MCP_SERVER_URL environment variable or pass mcp_server_url parameter")
            return

        try:
            logger.info(f"Attempting to connect to MCP server at {self.mcp_server_url}")

            mcp_headers = headers or {}
            if self.correlation_headers:
                mcp_headers.update(self.correlation_headers)
                logger.info(f"Using correlation headers for MCP connection: {list(mcp_headers.keys())}")

            self._mcp_context = streamablehttp_client(self.mcp_server_url, headers=mcp_headers)
            read, write, get_session_id = await self._mcp_context.__aenter__()
            self._mcp_read = read
            self._mcp_write = write
            self._get_session_id = get_session_id

            logger.info("MCP HTTP connection established, creating session...")

            self.mcp_session = ClientSession(read, write)
            await self.mcp_session.__aenter__()

            logger.info("MCP client session created, initializing...")
            await self.mcp_session.initialize()
            logger.info("MCP session initialized successfully")

            self.mcp_connected = True

            tools_result = await self.mcp_session.list_tools()
            logger.info(f"Connected to MCP server with {len(tools_result.tools)} tools: {[t.name for t in tools_result.tools]}")

            self._update_tools_from_mcp(tools_result.tools)

        except ConnectionError as e:
            logger.error(f"Connection error to MCP server at {self.mcp_server_url}: {e}", exc_info=True)
            self.mcp_connected = False
        except TimeoutError as e:
            logger.error(f"Timeout connecting to MCP server at {self.mcp_server_url}: {e}", exc_info=True)
            self.mcp_connected = False
        except Exception as e:
            logger.error(f"Failed to connect to MCP server: {type(e).__name__}: {e}", exc_info=True)
            self.mcp_connected = False

    async def disconnect_mcp(self):
        """Disconnect from MCP server and cleanup resources."""
        if self.mcp_session:
            try:
                await self.mcp_session.__aexit__(None, None, None)
            except Exception as e:
                logger.error(f"Error closing MCP session: {e}")

        if self._mcp_context:
            try:
                await self._mcp_context.__aexit__(None, None, None)
            except Exception as e:
                logger.error(f"Error closing MCP context: {e}")

        self.mcp_connected = False
        logger.info("Disconnected from MCP server")

    def _update_tools_from_mcp(self, mcp_tools):
        """Update OpenAI function definitions from MCP tool schemas."""
        self.tools = []
        for tool in mcp_tools:
            self.tools.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": tool.inputSchema or {"type": "object", "properties": {}}
                }
            })

    async def invoke(self, request: InvokeRequest) -> InvokeResponse:
        """Process user request and return response with tool uses."""

        logger.info(f"Processing request for test case: {request.test_case_id}")

        # Use custom system prompt if provided, otherwise use default
        SYSTEM_PROMPT = """You are a calendar scheduling and email communication assistant for Northwind Traders. You manage calendars and send emails on behalf of the user by calling tools. Never describe what you would do — always call the tool.

## RULES

1. ALWAYS call tools. Never say "I would send..." or "I would schedule..." — execute it.
2. Never ask for clarification. Use reasonable defaults for any missing parameters.
3. Complete ALL parts of a multi-step request before responding. If the user asks you to reschedule AND notify someone, you must call both mcp_CalendarTools_graph_createEvent AND sendMail.
4. Your final response must confirm what was done, listing every key detail (recipients, dates, times, content points).

## TOOLS

### mcp_CalendarTools_graph_createEvent
Create a calendar event. Required fields:
- subject: Event title (string)
- start: { "dateTime": "yyyy-MM-ddTHH:mm:ss", "timeZone": "America/New_York" }
- end: { "dateTime": "yyyy-MM-ddTHH:mm:ss", "timeZone": "America/New_York" }
- attendees_addresses: Array of email addresses

Defaults: 30 minutes duration if not specified. Use America/New_York timezone unless stated otherwise. Schedule during working hours (8 AM – 5 PM) when no time is given.

For recurrence, use the recurrence property with pattern (type: daily/weekly/absoluteMonthly/absoluteYearly, interval, daysOfWeek) and range (type: endDate/numbered/noEnd, startDate, endDate/numberOfOccurrences).

For online meetings, set isOnlineMeeting: true and onlineMeetingProvider: "teamsForBusiness".

### mcp_CalendarTools_graph_listEvents
List calendar events for a user. Use this to check availability and detect conflicts.
- userId: "me" for current user
- startDateTime / endDateTime: ISO 8601 format to filter date range

### sendMail
Send an email. Fields:
- to: Array of recipient email addresses
- subject: Email subject line
- body: Full email body text — include ALL details the user mentioned, do not summarize or omit points

### SearchMessages
Search Outlook messages with KQL queries.
- queryString: KQL search string (e.g., "from:user@example.com subject:report")

## CALENDAR CONFLICT HANDLING

When asked to check for conflicts or reschedule:
1. Call mcp_CalendarTools_graph_listEvents to retrieve existing events for the relevant time range
2. If the requested time overlaps with an existing event, pick the NEXT available slot (do NOT schedule at the conflicting time)
3. Create the event at the conflict-free time
4. If the user asked to notify attendees about the change, send an email via sendMail explaining the new time and reason

## EMAIL COMPOSITION

When composing emails:
- Include EVERY detail the user mentioned — do not drop or summarize any points
- Use a clear, professional subject line that reflects the email's purpose
- Structure the body logically (greeting, key points, action items, sign-off)
- Use the exact recipient email addresses provided by the user in the "to" field

## RESPONSE FORMAT

After completing all tool calls, respond with a confirmation that includes:
- What action(s) you performed
- All recipients, dates, times, durations, and locations
- A summary of all content points included in emails or event descriptions
- Any conflicts detected and how they were resolved"""

        sys_content = request.system_prompt if request.system_prompt else SYSTEM_PROMPT
        messages = [
            {
                "role": "system",
                "content": sys_content
            },
            {
                "role": "user",
                "content": request.input
            }
        ]

        tool_calls = []
        max_iterations = 10

        for iteration in range(max_iterations):
            # Build call kwargs — only include tools if the model supports them
            call_kwargs: Dict[str, Any] = {
                "model": self.deployment,
                "messages": messages,
            }
            use_tools = self.tools and self._supports_tools is not False
            if use_tools:
                call_kwargs["tools"] = self.tools
                call_kwargs["tool_choice"] = "auto"

            try:
                response = await self.client.chat.completions.create(**call_kwargs)
                # If we got here with tools, the model supports them
                if use_tools and self._supports_tools is None:
                    self._supports_tools = True
            except Exception as e:
                err_msg = str(e)
                if "does not support tools" in err_msg or "tool" in err_msg.lower() and "not support" in err_msg.lower():
                    # Model doesn't support tool calling — retry without tools
                    logger.warning(f"Model {self.deployment} does not support tools — falling back to plain completion")
                    self._supports_tools = False
                    call_kwargs.pop("tools", None)
                    call_kwargs.pop("tool_choice", None)
                    response = await self.client.chat.completions.create(**call_kwargs)
                else:
                    raise

            message = response.choices[0].message

            if not message.tool_calls:
                final_response = message.content or "Task completed."
                logger.info(f"Agent finished. Response: {final_response[:100]}...")
                break

            messages.append({
                "role": "assistant",
                "content": message.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments
                        }
                    }
                    for tc in message.tool_calls
                ]
            })

            for tool_call in message.tool_calls:
                function_name = tool_call.function.name
                function_args = json.loads(tool_call.function.arguments)

                logger.info(f"TOOL CALL: {function_name}")
                logger.info(f"   Arguments: {json.dumps(function_args, indent=2)}")

                result = await self._execute_tool(function_name, function_args)
                logger.info(f"TOOL RESULT: {function_name} completed")

                tool_calls.append(ToolCall(
                    name=function_name,
                    arguments=[
                        ToolArgument(name=k, value=v)
                        for k, v in function_args.items()
                    ],
                    response=result
                ))

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(result)
                })
        else:
            final_response = "Task completed after maximum iterations."
            logger.warning(f"Max iterations ({max_iterations}) reached")

        logger.info(f"EXECUTION SUMMARY: {len(tool_calls)} tool calls")
        return InvokeResponse(
            response=final_response,
            tool_calls=tool_calls
        )

    async def _execute_tool(self, function_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a tool function via MCP or fallback to mocks."""

        if self.mcp_connected and self.mcp_session:
            try:
                logger.info(f"Executing MCP tool: {function_name}")
                result = await self.mcp_session.call_tool(function_name, arguments)
                logger.info(f"MCP tool {function_name} responded successfully")

                if result.content:
                    content = result.content[0]
                    if hasattr(content, 'text'):
                        parsed = json.loads(content.text)
                        return parsed
                    else:
                        return {"result": str(content)}
                return {"status": "success"}

            except json.JSONDecodeError as e:
                logger.error(f"MCP tool {function_name} returned invalid JSON: {e}", exc_info=True)
                raise
            except Exception as e:
                logger.error(f"MCP tool call failed for {function_name}: {type(e).__name__}: {e}", exc_info=True)
                raise

        error_msg = f"Tool {function_name} not available - MCP server not connected"
        logger.error(error_msg)
        return {"error": error_msg, "mcp_connected": False}


# ============================================================================
# FastAPI Application
# ============================================================================

app = FastAPI(title="Calendar Agent", version="1.0.0")

mcp_server_url = os.getenv("MCP_SERVER_URL")
deployment_name = os.getenv("AGENT_LLM_MODEL", os.getenv("LLM_MODEL", "qwen3-coder:latest"))


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "status": "ok",
        "agent": "calendar",
        "version": "1.0.0"
    }


@app.post("/agents/calendar/invoke", response_model=InvokeResponse)
async def invoke_agent(request: InvokeRequest, http_request: Request):
    """Invoke the calendar agent with a user request."""
    try:
        correlation_headers = {}
        correlation_id = http_request.headers.get('x-correlationid')
        test_case_id = http_request.headers.get('x-testcaseid')

        if correlation_id:
            correlation_headers['x-correlationid'] = correlation_id
        if test_case_id:
            correlation_headers['x-testcaseid'] = test_case_id

        logger.info(f"Processing request with correlation headers: {correlation_headers}")

        request_agent = CalendarAgent(mcp_server_url)

        if correlation_headers:
            await request_agent.connect_mcp_with_headers(correlation_headers)
        else:
            await request_agent.connect_mcp()

        try:
            response = await request_agent.invoke(request)
            return response
        finally:
            await request_agent.disconnect_mcp()

    except Exception as e:
        logger.error(f"Error invoking agent: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/agents/calendar")
async def agent_info():
    """Get information about the calendar agent."""
    return {
        "name": "calendar",
        "description": "LLM-powered calendar scheduling agent (local)",
        "model": deployment_name,
        "mcp_server_url": mcp_server_url,
    }


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == "__main__":
    logger.info("Starting Calendar Agent server on port 8001...")
    uvicorn.run(app, host="0.0.0.0", port=8001)
