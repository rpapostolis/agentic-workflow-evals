"""
Setup script for the Computer Use Agent.

Registers the agent in AgentEval and creates a sample dataset of
browser automation tasks. Run this once before starting evaluations.

Usage:
  python -m agents.computer_use.setup
  # or with custom backend URL:
  AGENTEVAL_URL=http://localhost:8000 python -m agents.computer_use.setup
"""

import json
import os
import sys
import time

import httpx

# ── Configuration ─────────────────────────────────────────────────────────

AGENTEVAL_URL = os.environ.get("AGENTEVAL_URL", "http://localhost:8000")
CU_AGENT_URL = os.environ.get("CU_AGENT_URL", "http://localhost:8001/invoke")
API = f"{AGENTEVAL_URL}/api"


# ── Task Definitions ──────────────────────────────────────────────────────

TASKS = [
    # ── Information Retrieval (easier) ────────────────────────────────
    {
        "name": "Wikipedia: Country Population",
        "description": "Navigate to Wikipedia and find a specific country's population",
        "input": "Go to https://en.wikipedia.org/wiki/France and find the current population of France. Report the number.",
        "expected_response": "The population of France should be approximately 68 million",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should contain wikipedia.org and France"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should contain a specific population number for France, approximately 68 million or a similar recent figure"
        },
        "difficulty": "easy",
    },
    {
        "name": "Wikipedia: Capital City",
        "description": "Find the capital of a specific country on Wikipedia",
        "input": "Navigate to https://en.wikipedia.org/wiki/Japan and tell me the capital city and when it was established as the capital.",
        "expected_response": "Tokyo is the capital of Japan",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should navigate to the Japan Wikipedia page"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should mention Tokyo as the capital city of Japan and provide some historical context about when it became the capital"
        },
        "difficulty": "easy",
    },

    # ── Web Navigation (medium) ───────────────────────────────────────
    {
        "name": "Hacker News: Top Story",
        "description": "Find the current top story on Hacker News",
        "input": "Go to https://news.ycombinator.com and tell me the title of the #1 story on the front page and how many points it has.",
        "expected_response": "The top story title and its point count",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should be news.ycombinator.com or similar HN URL"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should contain the title of the #1 story and a specific point count. Both pieces of information must be present."
        },
        "difficulty": "easy",
    },
    {
        "name": "GitHub: Repository Info",
        "description": "Navigate to a GitHub repo and extract key information",
        "input": "Go to https://github.com/anthropics/anthropic-cookbook and tell me: (1) how many stars it has, (2) the primary programming language, and (3) the description/about text.",
        "expected_response": "Stars count, primary language (likely Python/Jupyter), and the repository description",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should be the anthropic-cookbook GitHub repository"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should contain all three requested pieces of information: star count (a number), primary programming language, and the repository description text"
        },
        "difficulty": "medium",
    },

    # ── Multi-step Interaction (medium) ───────────────────────────────
    {
        "name": "Wikipedia: Search and Navigate",
        "description": "Search for a topic on Wikipedia and extract information",
        "input": "Go to https://en.wikipedia.org and use the search bar to search for 'Claude Shannon'. Find and report: his birth year, his main contribution to science, and where he worked.",
        "expected_response": "Claude Shannon was born in 1916, his main contribution was information theory, and he worked at Bell Labs and MIT",
        "minimal_tool_set": ["navigate", "click", "type_text", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should be wikipedia.org"]
                    }
                ]
            },
            {
                "name": "type_text",
                "arguments": [
                    {
                        "name": "text",
                        "assertion": ["Should type 'Claude Shannon' or similar search query"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should mention: birth year (1916), information theory as his contribution, and Bell Labs/MIT as workplaces. At least 2 of 3 facts should be present."
        },
        "difficulty": "medium",
    },
    {
        "name": "AgentEval: Read Analytics",
        "description": "Navigate to the AgentEval dashboard and read analytics data",
        "input": "Go to http://localhost:5001/analytics and report what information is displayed on the Analytics dashboard. List the main sections and any key metrics shown.",
        "expected_response": "Description of the Analytics page sections and metrics",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should be localhost:5000/analytics"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should describe the AgentEval analytics page layout, mentioning sections like evaluation statistics, charts, or agent performance metrics"
        },
        "difficulty": "medium",
    },

    # ── Complex Tasks (hard) ──────────────────────────────────────────
    {
        "name": "AgentEval: List Agents",
        "description": "Navigate to AgentEval and list all registered agents",
        "input": "Go to http://localhost:5001/agents and list all agents currently registered in the system. For each agent, report its name and model.",
        "expected_response": "A list of agents with their names and models",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should be localhost:5000/agents"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should list agent names and their associated models. If no agents exist, it should clearly state that."
        },
        "difficulty": "medium",
    },
    {
        "name": "Multi-page Navigation",
        "description": "Visit multiple pages and compile information",
        "input": "Visit these three Wikipedia pages and create a brief comparison: https://en.wikipedia.org/wiki/Python_(programming_language), https://en.wikipedia.org/wiki/JavaScript, https://en.wikipedia.org/wiki/Rust_(programming_language). For each language, report: (1) the year it was first released, (2) who designed it, and (3) the typing discipline.",
        "expected_response": "Comparison of Python, JavaScript, and Rust with release year, designer, and typing discipline for each",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["Should navigate to at least the Python, JavaScript, or Rust Wikipedia pages"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should contain information about all three languages (Python, JavaScript, Rust) with at least 2 of the 3 requested facts for each language"
        },
        "difficulty": "hard",
    },
    {
        "name": "Form Interaction",
        "description": "Navigate to a page and interact with form elements",
        "input": "Go to https://httpbin.org/forms/post and fill out the form with: Customer name 'Jane Doe', size 'Medium', topping 'Bacon', and submit the form. Report what the response page shows.",
        "expected_response": "The httpbin response showing the submitted form data",
        "minimal_tool_set": ["navigate", "click", "type_text", "press_key", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["URL should be httpbin.org/forms/post"]
                    }
                ]
            },
            {
                "name": "type_text",
                "arguments": [
                    {
                        "name": "text",
                        "assertion": ["Should type 'Jane Doe' or similar customer name"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should describe the httpbin response page showing the submitted form data, including the customer name and at least some of the form values"
        },
        "difficulty": "hard",
    },
    {
        "name": "Error Recovery",
        "description": "Navigate to a broken URL and recover gracefully",
        "input": "Try to navigate to http://localhost:5001/nonexistent-page-xyz. If you get an error or blank page, navigate to the AgentEval home page instead and report what you see there.",
        "expected_response": "Should recognize the error and navigate to the correct page",
        "minimal_tool_set": ["navigate", "read_page_text", "done"],
        "tool_expectations": [
            {
                "name": "navigate",
                "arguments": [
                    {
                        "name": "url",
                        "assertion": ["Should first try the nonexistent page, then navigate to a working page"]
                    }
                ]
            }
        ],
        "response_quality_expectation": {
            "assertion": "Response should indicate that the original page was not found or errored, AND describe what was found on the fallback/home page"
        },
        "difficulty": "medium",
    },
]

# ── Custom Judge Config for Computer Use ──────────────────────────────────

JUDGE_CONFIG = {
    "name": "Computer Use Judge",
    "system_prompt": """You are an expert judge evaluating a computer use agent's performance on web automation tasks.

You will be given:
1. The task the agent was asked to complete
2. The agent's actual response
3. An assertion to evaluate

Consider these factors:
- Did the agent find the correct information?
- Is the response accurate and complete?
- Did the agent handle errors gracefully?

Be strict but fair. The agent should provide specific, factual answers.""",
    "user_prompt_template_single": """Task Input: {{test_input}}

Agent Response: {{agent_response}}

Expected Behavior: {{expected_response}}

Assertion to evaluate: {{assertion}}

Did the agent's response satisfy this assertion? Respond with PASS or FAIL followed by your reasoning.""",
    "user_prompt_template_batched": """Task Input: {{test_input}}

Agent Response: {{agent_response}}

Expected Behavior: {{expected_response}}

Evaluate each of the following assertions. For each, respond PASS or FAIL with reasoning:
{{assertions}}""",
    "scoring_mode": "binary",
    "notes": "Custom judge for computer use agent evaluation — focuses on task completion accuracy and information extraction quality",
}


# ── Setup Functions ───────────────────────────────────────────────────────

def setup():
    """Register the agent, create dataset, and add test cases."""
    client = httpx.Client(base_url=API, timeout=30)

    print("=" * 60)
    print("  Computer Use Agent — Setup")
    print("=" * 60)
    print(f"  AgentEval API: {API}")
    print(f"  Agent endpoint: {CU_AGENT_URL}")
    print()

    # 1. Register the agent
    print("[1/4] Registering Computer Use Agent...")
    agent_data = {
        "name": "Computer Use Agent",
        "description": "Local browser automation agent powered by Ollama + Playwright. Uses screenshots and DOM text with a multimodal vision-language model to navigate websites, extract information, fill forms, and complete multi-step workflows. Runs 100% locally — no API keys required.",
        "model": os.environ.get("OLLAMA_MODEL", "qwen3-vl:4b"),
        "agent_invocation_url": CU_AGENT_URL,
        "tags": ["computer-use", "browser", "ollama", "local"],
        "default_risk_tier": "tier_2",
        "sampling_rate": 1.0,
    }

    try:
        resp = client.post("/agents", json=agent_data)
        resp.raise_for_status()
        agent = resp.json()
        agent_id = agent["id"]
        print(f"  ✓ Agent registered: {agent_id}")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 422:
            # Try listing existing agents to find ours
            agents_resp = client.get("/agents")
            agents = agents_resp.json()
            existing = [a for a in agents if a["name"] in ("Computer Use Agent", "Computer Use Agent")]
            if existing:
                agent_id = existing[0]["id"]
                print(f"  ✓ Agent already exists: {agent_id}")
            else:
                print(f"  ✗ Failed to create agent: {e.response.text}")
                return
        else:
            print(f"  ✗ Failed to create agent: {e.response.text}")
            return

    # 2. Create the dataset
    print("[2/4] Creating Computer Use Tasks dataset...")
    dataset_data = {
        "name": "Computer Use Tasks",
        "goal": "Evaluate the computer use agent's ability to navigate websites, extract information, interact with forms, and handle errors across a range of difficulty levels.",
        "input": {},
        "schema_hash": "",
    }

    try:
        resp = client.post("/datasets", json=dataset_data)
        resp.raise_for_status()
        dataset = resp.json()
        dataset_id = dataset["id"]
        print(f"  ✓ Dataset created: {dataset_id}")
    except httpx.HTTPStatusError as e:
        # Try listing existing datasets
        ds_resp = client.get("/datasets")
        datasets = ds_resp.json()
        existing = [d for d in datasets if d.get("seed", {}).get("name") == "Computer Use Tasks"]
        if existing:
            dataset_id = existing[0]["id"]
            print(f"  ✓ Dataset already exists: {dataset_id}")
        else:
            print(f"  ✗ Failed to create dataset: {e.response.text}")
            return

    # 3. Add test cases
    print(f"[3/4] Adding {len(TASKS)} test cases...")
    created_count = 0
    for task in TASKS:
        tc_data = {
            "name": task["name"],
            "description": task["description"],
            "input": task["input"],
            "expected_response": task["expected_response"],
            "minimal_tool_set": task["minimal_tool_set"],
            "tool_expectations": task["tool_expectations"],
            "response_quality_expectation": task.get("response_quality_expectation"),
            "is_holdout": False,
        }

        try:
            resp = client.post(f"/datasets/{dataset_id}/testcases", json=tc_data)
            resp.raise_for_status()
            created_count += 1
            difficulty = task.get("difficulty", "?")
            print(f"  ✓ [{difficulty}] {task['name']}")
        except httpx.HTTPStatusError as e:
            body = e.response.text[:200] if e.response.text else ""
            print(f"  ✗ {task['name']}: {e.response.status_code} — {body}")

    print(f"  → {created_count}/{len(TASKS)} test cases created")

    # 4. Create custom judge config
    print("[4/4] Creating Computer Use judge config...")
    try:
        resp = client.post("/judge-configs", json=JUDGE_CONFIG)
        resp.raise_for_status()
        judge = resp.json()
        print(f"  ✓ Judge config created: {judge.get('id', 'ok')}")
    except httpx.HTTPStatusError as e:
        if "already exists" in str(e.response.text).lower() or e.response.status_code == 409:
            print("  ✓ Judge config already exists")
        else:
            print(f"  ⚠ Judge config: {e.response.status_code} (non-critical)")

    # Summary
    print()
    print("=" * 60)
    print("  Setup Complete!")
    print("=" * 60)
    print()
    print("  Next steps:")
    print("  1. Start the agent server:")
    print("     cd src && python -m agents.computer_use.server")
    print()
    print("  2. Open AgentEval and start an evaluation:")
    print(f"     Agent: Computer Use Agent ({agent_id})")
    print(f"     Dataset: Computer Use Tasks ({dataset_id})")
    print(f"     Endpoint: {CU_AGENT_URL}")
    print()
    print("  3. Watch results flow through Analytics, Monitoring,")
    print("     Intelligence, and HITL Review!")
    print()


if __name__ == "__main__":
    setup()
