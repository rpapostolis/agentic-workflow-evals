"""
seed_service.py — Programmatic demo data seeder for AgentEval.

Extracts the core seeding logic from seed_demo.py so it can be called
from the FastAPI admin endpoint (POST /api/admin/seed-demo).
"""

import json, os, random, sqlite3, uuid
from datetime import datetime, timedelta, timezone
from . import config
from .models import CostRecord

DB_PATH = config.SQLITE_DB_PATH


def _uid(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _ts(dt):
    return dt.isoformat()


def _jitter(base, h=6):
    return base + timedelta(hours=random.uniform(0, h), minutes=random.randint(0, 59))


def seed_demo_data() -> dict:
    """Insert full supply-chain demo dataset into the DB. Returns summary counts."""
    random.seed(42)

    BASE_DATE = datetime(2026, 1, 20, 8, 0, tzinfo=timezone.utc)

    # ── 10 Agents ──
    AGENTS = [
        {"id": _uid("agent"), "name": "Procurement Agent",
         "description": "Purchase order creation, RFQ processing, supplier selection, and spend analysis",
         "model": "gpt-4o",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Warehouse Manager",
         "description": "Inventory management, put-away optimization, picking routes, and cycle counts",
         "model": "claude-sonnet-4",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Logistics Coordinator",
         "description": "Shipment tracking, carrier selection, route optimization, and freight auditing",
         "model": "gpt-4o",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Demand Forecaster",
         "description": "Demand prediction, seasonal planning, SKU-level analysis, and safety stock calculation",
         "model": "claude-sonnet-4",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Supplier Relationship Manager",
         "description": "Supplier evaluation, scorecard management, compliance tracking, and communication",
         "model": "gpt-4o-mini",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Quality Inspector",
         "description": "Incoming goods inspection, defect tracking, non-conformance reports, and CAPA management",
         "model": "claude-haiku",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Order Fulfillment Agent",
         "description": "Order processing, stock allocation, delivery scheduling, and customer notification",
         "model": "gpt-4o-mini",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Customs & Trade Compliance",
         "description": "Customs declarations, tariff classification, trade documentation, and sanctions screening",
         "model": "claude-sonnet-4",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Fleet Manager",
         "description": "Vehicle tracking, maintenance scheduling, driver assignment, and fuel optimization",
         "model": "gpt-4o-mini",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Returns & Reverse Logistics",
         "description": "Returns processing, RMA management, refurbishment routing, and disposal compliance",
         "model": "claude-haiku",
         "agent_invocation_url": "http://localhost:8000/api/mock-agent/invoke"},
        {"id": _uid("agent"), "name": "Computer Use Agent",
         "description": "Local browser automation agent powered by Ollama + Playwright. Uses screenshots and DOM text with qwen3-vl:4b to navigate websites, extract information, fill forms, and complete multi-step workflows. Runs 100% locally.",
         "model": "qwen3-vl:4b",
         "agent_invocation_url": "http://localhost:8001/invoke"},
    ]
    for a in AGENTS:
        a["createdAt"] = _ts(BASE_DATE - timedelta(days=random.randint(5, 20)))

    # ── Team and tags on agents (Analytics Hub Phase 1) ──
    teams = ["platform", "ml-ops", "customer-success", "infrastructure", "data-engineering"]
    for i, a in enumerate(AGENTS):
        a["team"] = teams[i % len(teams)]
        if a["name"] == "Computer Use Agent":
            a["tags"] = ["computer-use", "browser", "ollama", "local"]
        elif i < 3:
            a["tags"] = ["production", "critical"]
        elif i < 6:
            a["tags"] = ["staging", "experimental"]
        else:
            a["tags"] = ["development", "testing"]

    # ── Datasets ──
    def make_dataset(name, goal, domain, test_defs):
        ds_id = _uid("dataset")
        tc_ids, tcs = [], []
        for td in test_defs:
            tc_id = _uid("tc")
            tc_ids.append(tc_id)
            tcs.append({
                "id": tc_id, "dataset_id": ds_id, "name": td["name"],
                "description": td["desc"], "input": td["input"],
                "minimal_tool_set": td.get("tools", []),
                "tool_expectations": td.get("tool_expectations", []),
                "expected_response": td.get("expected", "Agent completes the task correctly."),
                "response_quality_expectation": None,
                "references_seed": {}, "is_holdout": td.get("holdout", False),
            })
        ds = {
            "id": ds_id,
            "metadata": {"generator_id": _uid("gen"), "suite_id": _uid("suite"),
                          "created_at": _ts(BASE_DATE - timedelta(days=7)), "version": "1.0", "schema_hash": ""},
            "seed": {"name": name, "goal": goal, "synthetic_domain": domain, "input": {}},
            "test_case_ids": tc_ids,
            "created_at": _ts(BASE_DATE - timedelta(days=7)),
        }
        return ds, tcs

    PROCUREMENT_TESTS = [
        {"name": "RFQ Generation for Raw Materials", "desc": "Generate RFQ for 50 tons of cold-rolled steel, distribute to 3 qualified suppliers",
         "input": "Create RFQ for 50 tons cold-rolled steel (Grade 304), delivery to Plant #2 Stuttgart by March 15. Send to approved suppliers: ArcelorMittal, Tata Steel Europe, POSCO. Include quality cert requirements (EN 10088-2).",
         "tools": ["create_rfq", "lookup_supplier", "send_notification", "check_inventory"],
         "expected": "RFQ created with correct specs, sent to all 3 suppliers with quality cert requirements and delivery deadline."},
        {"name": "Supplier Price Comparison", "desc": "Compare 3 vendor quotes for packaging materials and recommend best value",
         "input": "Compare quotes for corrugated boxes (600x400x300mm): VendorA: €0.82/unit MOQ 10K, lead 5d. VendorB: €0.74/unit MOQ 25K, lead 12d. VendorC: €0.79/unit MOQ 5K, lead 3d. Current monthly usage: 18K units.",
         "tools": ["lookup_supplier", "calculate_total_cost", "create_report"],
         "expected": "Analysis showing total cost of ownership including MOQ impact, lead time risk, and recommendation based on current usage patterns."},
        {"name": "Emergency Procurement for Production Shortage", "desc": "Handle urgent procurement when production line faces stockout in 48 hours",
         "input": "URGENT: Bearing assembly #BA-4420 stock at 23 units, production needs 200/day. Current PO #PO-2026-1847 delayed 2 weeks (supplier quality issue). Find alternative source immediately.",
         "tools": ["check_inventory", "lookup_supplier", "create_purchase_order", "send_alert", "escalate_to_lead"],
         "expected": "Alternative supplier identified, emergency PO created with expedited shipping, production team and management notified of timeline."},
        {"name": "Contract Renewal with Price Escalation", "desc": "Review expiring supplier contract and flag unfavorable escalation terms",
         "input": "Contract #SC-2024-089 with Henkel Adhesives expires March 30. Current terms: base €12.40/kg, annual escalation tied to ICIS index +3.5% cap. Review proposed renewal: same base, escalation changed to CPI +5% uncapped. Volume: 340 tons/year.",
         "tools": ["read_document", "calculate_total_cost", "create_report", "send_notification"],
         "expected": "Flag uncapped escalation as high risk, calculate 3-year cost impact, recommend counter-proposal with cap or index change."},
        {"name": "Multi-Tier Supplier Risk Assessment", "desc": "Assess risk across supplier tiers when Tier-2 supplier faces disruption",
         "input": "Tier-2 supplier Nidec (motors) reports factory fire in Dalian plant. Affected Tier-1 suppliers: Bosch Rexroth (hydraulic valves) and Siemens (drive controllers). Map impact to our assembly lines and estimate recovery timeline.",
         "tools": ["lookup_supplier", "check_inventory", "create_report", "send_alert"],
         "expected": "Risk map showing affected SKUs per assembly line, current buffer stock days, alternative sourcing options, and recommended mitigation actions."},
        {"name": "Purchase Order Approval Workflow", "desc": "Route PO through correct approval chain based on value and category",
         "input": "New PO request: 500 servo motors from Fanuc, unit price €1,240, total €620,000. Category: Capital Equipment. Requestor: Plant Manager Munich. Budget remaining: €480,000.",
         "tools": ["create_purchase_order", "check_budget", "route_approval", "send_notification"],
         "expected": "PO flagged as over-budget, routed to VP Supply Chain for exception approval, budget office notified with variance explanation."},
        {"name": "Supplier Onboarding Validation", "desc": "Validate new supplier documentation and compliance before activation",
         "input": "Onboard new supplier: Shanghai Precision Parts Co. Documents received: business license, ISO 9001:2015 cert, financial statements (2024-2025). Missing: conflict minerals declaration, REACH compliance cert. Country risk: Medium (China).",
         "tools": ["validate_documents", "check_compliance", "create_report", "send_notification"],
         "expected": "Checklist showing completed and missing items, compliance gaps flagged, conditional approval with action items for missing documents."},
        {"name": "Incoterms Selection for International Shipment", "desc": "Recommend optimal Incoterms for a cross-border procurement",
         "input": "Procuring CNC machine (€85,000, 2.4 tons) from DMG Mori, Nagoya Japan. Destination: Plant #3 Bratislava, Slovakia. We have no freight forwarder relationship in Asia. Buyer preference: minimize risk during ocean transit.",
         "tools": ["calculate_total_cost", "lookup_supplier", "create_report"],
         "expected": "Recommend CIP or CIF to shift transit risk to seller, with cost comparison across DAP/CIF/FOB including insurance and customs estimates.",
         "holdout": True},
        {"name": "MOQ Negotiation for Small Batch", "desc": "Negotiate below-MOQ order for prototype production run",
         "input": "Need 150 custom PCBs (part #PCB-X7-REV3) for prototype. Supplier Würth Elektronik MOQ is 1,000 units at €14.20/unit. Prototype budget: €5,000. Full production (Q3) estimated at 15,000 units.",
         "tools": ["lookup_supplier", "send_notification", "create_purchase_order"],
         "expected": "Draft negotiation email offering future volume commitment in exchange for reduced MOQ or tooling cost split for prototype run."},
        {"name": "Budget Threshold Alert and Re-routing", "desc": "Detect spend approaching category budget limit and trigger controls",
         "input": "Category: MRO Supplies. YTD spend: €892,400. Annual budget: €950,000. Pending POs: €73,200. Month: October (3 months remaining). Historical Q4 spend avg: €180,000.",
         "tools": ["check_budget", "create_report", "send_alert", "route_approval"],
         "expected": "Alert that projected spend exceeds budget by ~€95K, recommend spend freeze on non-critical MRO, escalate to finance with reallocation request."},
    ]

    WAREHOUSE_TESTS = [
        {"name": "Inbound Receiving and Put-Away", "desc": "Process inbound shipment, verify against PO, and assign storage locations",
         "input": "Truck arrived at Dock 7 with PO #PO-2026-2103 from Bosch. Manifest: 400x bearing assemblies, 200x seal kits, 50x hydraulic cylinders. PO quantities: 400, 250, 50. Pallet count: 12. Note: seal kits short-shipped (200 vs 250 ordered).",
         "tools": ["verify_shipment", "update_inventory", "assign_storage", "create_discrepancy_report", "send_notification"],
         "expected": "Shipment received with discrepancy noted (50 seal kits short), items put away in correct zones, supplier notified of shortage, receiving report filed."},
        {"name": "Pick-Pack-Ship Multi-Item Order", "desc": "Process customer order with items across multiple warehouse zones",
         "input": "Order #SO-48291 for Volkswagen Bratislava: 80x hydraulic valves (Zone A-3), 200x gasket sets (Zone C-1), 40x pressure sensors (Zone B-7, requiring ESD handling). Ship via DHL Express, delivery by Friday. Hazmat: None.",
         "tools": ["generate_pick_list", "check_inventory", "create_shipment", "print_labels", "send_notification"],
         "expected": "Optimized pick route across zones, ESD-safe handling flagged for sensors, packing slip generated, DHL booking created with Friday delivery."},
        {"name": "Cycle Count Discrepancy Resolution", "desc": "Investigate and resolve inventory variance found during cycle count",
         "input": "Cycle count Zone B-4, Bin 17: System shows 342 units of part #FLG-2200 (flange connectors). Physical count: 298 units. Variance: -44 units (12.9%). Last movement: 3 days ago, picked 60 units for SO-48102. Tolerance: 5%.",
         "tools": ["check_inventory", "query_transactions", "create_adjustment", "create_report", "send_alert"],
         "expected": "Root cause investigation (check recent picks, returns, transfers), adjustment posted with documentation, variance report to inventory control manager."},
        {"name": "Cross-Dock Routing for Perishable Goods", "desc": "Route time-sensitive materials directly to outbound dock without storage",
         "input": "Inbound: 2 pallets of temperature-sensitive adhesive (shelf life 72h from manufacture, manufactured yesterday) from Henkel. Outbound order SO-48310 needs same adhesive, shipping tomorrow morning. Available outbound dock: Dock 3.",
         "tools": ["verify_shipment", "check_orders", "assign_dock", "update_inventory", "create_shipment"],
         "expected": "Cross-dock routed directly from receiving Dock to outbound Dock 3, cold chain integrity maintained, tomorrow's shipment pre-staged."},
        {"name": "Backorder Allocation on Stock Replenishment", "desc": "Allocate newly received stock against backlog of waiting orders",
         "input": "Received 500 units of part #MTR-5500 (stepper motors). Backorder queue: SO-48050 (120 units, priority A, 5 days overdue), SO-48199 (300 units, priority B, 2 days overdue), SO-48287 (200 units, priority C, due tomorrow). Total backorder: 620 units.",
         "tools": ["check_inventory", "allocate_stock", "update_orders", "send_notification"],
         "expected": "Allocate by priority: SO-48050 gets 120, SO-48199 gets 300, SO-48287 gets remaining 80 (partial fill). All customers notified of allocation."},
        {"name": "Hazmat Storage Zone Compliance", "desc": "Validate hazmat placement rules when receiving dangerous goods",
         "input": "Receiving 20 drums (200L each) of isopropyl alcohol (UN1219, Flammability Class 3). Current hazmat zone H-2 has 15 drums of acetone (also Class 3) and 8 drums of nitric acid (Class 8, oxidizer). Max Class 3 capacity: 40 drums.",
         "tools": ["check_storage_rules", "assign_storage", "update_inventory", "create_report"],
         "expected": "Flag incompatibility: IPA (Class 3 flammable) cannot be stored near nitric acid (Class 8 oxidizer). Assign to Zone H-1 or require segregation barrier.",
         "holdout": True},
        {"name": "FIFO Lot Rotation for Expiring Stock", "desc": "Identify and prioritize lots approaching expiration for next picks",
         "input": "Part #ADH-3300 (structural adhesive), 4 lots in stock: Lot A (exp Mar 1, qty 45), Lot B (exp Apr 15, qty 180), Lot C (exp Jun 30, qty 200), Lot D (exp Feb 20, qty 30). Today: Feb 5. Next 5 orders need total 210 units.",
         "tools": ["check_inventory", "update_pick_priority", "send_alert", "create_report"],
         "expected": "Pick Lot D first (30 units, expires soonest), then Lot A (45 units), then Lot B for remainder. Alert: Lot D has only 15 days to expiry, prioritize immediately."},
        {"name": "Returns Inspection and Restocking", "desc": "Process customer return, inspect quality, and decide disposition",
         "input": "RMA #RMA-2026-0847: Customer ZF Friedrichshafen returning 50x pressure regulators (part #PR-8800). Reason: 'intermittent pressure drops under load'. Original order: SO-47885 shipped 3 weeks ago. Unit cost: €340. Return shipping paid by us.",
         "tools": ["process_return", "inspect_quality", "update_inventory", "create_report", "send_notification"],
         "expected": "Receive and inspect: test sample (10 units) under load conditions. Classify as restock, rework, or scrap. Issue credit note or replacement based on findings. Notify quality team of potential batch issue."},
    ]

    LOGISTICS_TESTS = [
        {"name": "Multi-Modal Route Optimization", "desc": "Optimize route combining truck and rail for cost-effective long-haul",
         "input": "Ship 22 pallets (14 tons) from Stuttgart warehouse to Madrid distribution center. Options: full truck (1,750 km, 2 days, €2,400), truck-to-rail (truck to Basel intermodal terminal, rail to Barcelona, truck to Madrid, 4 days, €1,680), express truck (1.5 days, €3,100). Delivery window: 5 business days.",
         "tools": ["calculate_route", "compare_carriers", "create_shipment", "send_notification"],
         "expected": "Recommend truck-to-rail as best value within window, with booking details for each leg and contingency if rail slot unavailable."},
        {"name": "Last-Mile Delivery Dense Urban Scheduling", "desc": "Schedule 28 deliveries in Munich metro area with time-window constraints",
         "input": "28 delivery stops in Munich today. Constraints: 6 stops need morning delivery (before 10am), 4 stops have loading dock access only, 8 stops are residential (staircase carry). 2 vehicles available: 7.5t truck (dock access) and 3.5t van. Driver hours: max 9h each.",
         "tools": ["optimize_route", "assign_vehicle", "assign_driver", "send_notification"],
         "expected": "Split deliveries optimally: truck handles dock-access stops + heavy items, van handles residential. Route minimizes total distance while meeting time windows."},
        {"name": "Customs Declaration Cross-Border Shipment", "desc": "Prepare customs documentation for EU-to-UK shipment post-Brexit",
         "input": "Export 3 pallets automotive sensors (HS code 9031.80) from Germany to UK customer JLR Solihull. Value: €42,000. Weight: 890 kg. Origin: manufactured in Germany (EU origin). Require: commercial invoice, export declaration, UK import declaration, EUR.1 movement cert.",
         "tools": ["classify_tariff", "generate_customs_docs", "check_compliance", "create_shipment"],
         "expected": "Complete customs package with correct HS classification, TCA preferential tariff rate applied, all declarations prepared, EORI numbers verified."},
        {"name": "Carrier SLA Breach Escalation", "desc": "Handle repeated late deliveries from contracted carrier",
         "input": "Carrier DB Schenker: 3 late deliveries this month (SLA: 98% on-time, current: 91%). Shipment #SH-2026-4421 arrived 18h late to BMW Dingolfing (production impact). Contract penalty clause: €500 per late delivery after 3rd instance. Total affected shipments this quarter: 7/82.",
         "tools": ["query_shipment_history", "calculate_penalties", "create_report", "send_notification", "escalate_to_lead"],
         "expected": "SLA breach report with evidence, penalty calculation (4 eligible x €500 = €2,000), escalation to carrier account manager, and recommendation to activate backup carrier for critical lanes."},
        {"name": "Temperature-Controlled Shipment Monitoring", "desc": "Monitor cold-chain shipment and respond to temperature excursion alert",
         "input": "ALERT: Reefer container MSCU-4871203 carrying pharmaceutical-grade silicone (req: 15-25C) shows temperature spike to 28.4C at 14:32 UTC. Location: A7 motorway near Kassel. Destination: Novo Nordisk, Copenhagen. ETA: 16h. Cargo value: €180,000.",
         "tools": ["check_shipment_status", "send_alert", "contact_driver", "create_incident", "check_compliance"],
         "expected": "Immediate driver contact to check reefer unit, log excursion with duration and peak, assess product impact per spec sheet, notify recipient with deviation report.",
         "holdout": True},
        {"name": "Fleet Preventive Maintenance Scheduling", "desc": "Schedule maintenance for fleet vehicles based on mileage and time triggers",
         "input": "Fleet vehicle DE-FL-089 (MAN TGX 18.470): current odometer 142,350 km, last service at 130,000 km (oil + filters), next major service due at 150,000 km (brakes + transmission). Average daily usage: 380 km. Vehicle assigned to Stuttgart-Milan route next week (1,250 km round trip).",
         "tools": ["check_vehicle_status", "schedule_maintenance", "assign_vehicle", "send_notification"],
         "expected": "Schedule major service after Milan run (will be at ~143,600 km, still under 150K threshold). Flag: if Milan route extends, vehicle hits service threshold mid-trip. Assign backup vehicle as contingency."},
        {"name": "Demand Forecast Seasonal Peak Planning", "desc": "Generate demand forecast for Q4 peak season with safety stock recommendations",
         "input": "SKU group: Automotive Fasteners (23 SKUs). Historical Q4 uplift: +35% (2024), +42% (2025). Current avg daily demand: 4,200 units. Key customer forecasts received: BMW +40%, Audi +25%, Porsche +60%. Current inventory: 89,000 units. Lead time: 18 days.",
         "tools": ["analyze_demand_history", "calculate_safety_stock", "create_forecast", "create_report"],
         "expected": "Weighted forecast showing Q4 daily demand ~6,100 units, safety stock recommendation of 28 days (vs current 21), pre-build schedule starting mid-September."},
        {"name": "Freight Invoice Audit and Dispute", "desc": "Audit carrier invoice against contracted rates and flag discrepancies",
         "input": "Invoice #INV-DB-2026-8834 from DB Schenker: 12 line items, total €18,420. Contract rate: €1.85/km for FTL, €0.12/kg for LTL. Line 7: Hamburg-Munich FTL, 790 km, charged €1,738 (rate: €2.20/km). Line 11: LTL 2,400 kg, charged €384 (rate: €0.16/kg). All other lines within tolerance.",
         "tools": ["verify_invoice", "calculate_total_cost", "create_dispute", "send_notification"],
         "expected": "Flag line 7 (overcharge €277, rate 19% above contract) and line 11 (overcharge €96, rate 33% above contract). Total dispute: €373. Generate dispute memo with supporting contract clauses."},
    ]

    COMPUTER_USE_TESTS = [
        {"name": "Wikipedia: Country Population", "desc": "Navigate to Wikipedia and find a specific country's population",
         "input": "Go to https://en.wikipedia.org/wiki/France and find the current population of France. Report the number.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should contain a plausible population number for the country mentioned in the task"]}]},
         ],
         "expected": "The population of France should be approximately 68 million."},
        {"name": "Wikipedia: Capital City", "desc": "Find the capital of a specific country on Wikipedia",
         "input": "Navigate to https://en.wikipedia.org/wiki/Japan and tell me the capital city.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should mention the correct capital city for the country in the task"]}]},
         ],
         "expected": "Tokyo is the capital of Japan."},
        {"name": "Hacker News: Top Story", "desc": "Find the current top story on Hacker News",
         "input": "Go to https://news.ycombinator.com and tell me the title of the #1 story on the front page.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should not be empty and should contain a non-generic text that looks like an article or project title"]}]},
         ],
         "expected": "The title of the top story on Hacker News."},
        {"name": "GitHub: Repository Info", "desc": "Navigate to a GitHub repo and extract key information",
         "input": "Go to https://github.com/anthropics/anthropic-cookbook and tell me the description/about text and the primary programming language.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should mention at least one programming language relevant to the repository"]}]},
         ],
         "expected": "The repository description and primary language (likely Python or Jupyter Notebook)."},
        {"name": "Wikipedia: Direct Lookup", "desc": "Navigate directly to a Wikipedia article and extract specific facts",
         "input": "Go to https://en.wikipedia.org/wiki/Claude_Shannon and find: his birth year and his main contribution to science.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should include the birth year and main scientific contribution of the person in the task"]}]},
         ],
         "expected": "Claude Shannon was born in 1916 and his main contribution was information theory."},
        {"name": "Wikipedia: Programming Language", "desc": "Look up basic facts about a programming language",
         "input": "Go to https://en.wikipedia.org/wiki/Python_(programming_language) and report: the year it was first released and who designed it.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should include the first release year and the designer of the programming language in the task"]}]},
         ],
         "expected": "Python was first released in 1991 and designed by Guido van Rossum."},
        {"name": "Form Interaction", "desc": "Navigate to a form page, fill in fields and submit",
         "input": "Go to https://httpbin.org/forms/post, fill in the customer name field with 'POST Test', select 'Medium' pizza size, and click the Submit Order button.",
         "tools": ["navigate", "click", "type_text", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "type_text", "arguments": [{"name": "text", "assertion": ["Text typed should match the customer name from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should indicate the form was submitted or show submitted data"]}]},
         ],
         "expected": "The agent should fill in the customer name with 'POST Test', select Medium size, and submit the form. The result page should show the submitted data."},
        {"name": "Error Recovery", "desc": "Handle an HTTP error and navigate to a fallback page",
         "input": "Go to https://httpbin.org/status/404 — this page intentionally returns a 404 error with a blank page. After you see the blank or error page, navigate to https://httpbin.org/html and describe the content you find there.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["At least one navigate call should target the fallback URL from the task (httpbin.org/html)"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should describe the HTML content found on the fallback page"]}]},
         ],
         "expected": "Should recognize the blank 404 page and navigate to the fallback HTML page, then describe its content (Herman Melville text)."},
        {"name": "AgentEval: Read Analytics", "desc": "Navigate to the AgentEval dashboard and read analytics data",
         "input": "Go to http://localhost:5001/analytics and report what information is displayed on the Analytics dashboard. List the main sections visible.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should describe dashboard sections or analytics content"]}]},
         ],
         "expected": "Description of the Analytics page sections and metrics."},
        {"name": "AgentEval: List Agents", "desc": "Navigate to AgentEval and list all registered agents",
         "input": "Go to http://localhost:5001/agents and list all agents currently registered in the system. For each agent, report its name.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should list at least one agent name"]}]},
         ],
         "expected": "A list of agents with their names.",
         "holdout": True},

        # ── Holdout test cases (never shown during prompt tuning) ──────────
        {"name": "Wikipedia: Table Reading", "desc": "Extract specific data from a table on a Wikipedia article",
         "input": "Go to https://en.wikipedia.org/wiki/List_of_largest_cities and find the largest city by population listed in the main table. Report its name and population.",
         "tools": ["navigate", "scroll", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should name a specific city and include a population figure"]}]},
         ],
         "expected": "The largest city by population from the table, with its population number.",
         "holdout": True},
        {"name": "httpbin: Headers Inspection", "desc": "Navigate to an API debug endpoint and report request headers",
         "input": "Go to https://httpbin.org/headers and report the User-Agent header value shown on the page.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should contain a User-Agent string that includes a browser or HTTP client name"]}]},
         ],
         "expected": "The User-Agent header value, which should mention a browser engine like Chrome or HeadlessChrome.",
         "holdout": True},
        {"name": "Wikipedia: Multi-fact Extraction", "desc": "Extract multiple distinct facts from a single Wikipedia article",
         "input": "Go to https://en.wikipedia.org/wiki/Moon and find: the Moon's diameter in kilometers and the year of the first crewed lunar landing.",
         "tools": ["navigate", "scroll", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should include both a diameter measurement and a year for the first crewed landing"]}]},
         ],
         "expected": "The Moon's diameter is approximately 3,474 km and the first crewed landing was in 1969.",
         "holdout": True},
        {"name": "GitHub: Stars and License", "desc": "Extract repository metadata beyond the basics",
         "input": "Go to https://github.com/microsoft/vscode and report: the approximate number of stars and the license type.",
         "tools": ["navigate", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should include a star count (a number) and a license name"]}]},
         ],
         "expected": "VS Code has approximately 170k+ stars and uses the MIT License.",
         "holdout": True},
        {"name": "Form Interaction: Radio and Checkbox", "desc": "Fill a form with multiple input types including radio buttons and checkboxes",
         "input": "Go to https://httpbin.org/forms/post, fill in the customer name with 'Holdout Test', select 'Large' pizza size, check both 'Mushrooms' and 'Onions' toppings, and submit the order.",
         "tools": ["navigate", "click", "type_text", "select_option", "done"],
         "tool_expectations": [
             {"name": "navigate", "arguments": [{"name": "url", "assertion": ["URL should match the target URL from the task input"]}]},
             {"name": "type_text", "arguments": [{"name": "text", "assertion": ["Text typed should match the customer name from the task input"]}]},
             {"name": "done", "arguments": [{"name": "result", "assertion": ["Result should indicate the form was submitted and mention the selections from the task"]}]},
         ],
         "expected": "Form submitted with name 'Holdout Test', Large size, Mushrooms and Onions toppings selected.",
         "holdout": True},
    ]

    ds_procurement, tc_procurement = make_dataset(
        "Procurement & Sourcing Suite",
        "Purchase order accuracy, supplier evaluation quality, and spend control",
        "supply-chain-procurement", PROCUREMENT_TESTS)

    ds_warehouse, tc_warehouse = make_dataset(
        "Warehouse & Fulfillment Suite",
        "Inventory accuracy, pick efficiency, storage compliance, and order fulfillment quality",
        "supply-chain-warehouse", WAREHOUSE_TESTS)

    ds_logistics, tc_logistics = make_dataset(
        "Logistics & Transportation Suite",
        "Route optimization, customs compliance, carrier management, and demand planning accuracy",
        "supply-chain-logistics", LOGISTICS_TESTS)

    ds_computer_use, tc_computer_use = make_dataset(
        "Browser Automation Suite",
        "Evaluate the computer use agent's ability to navigate websites, extract information, interact with forms, and handle errors",
        "computer-use-browser", COMPUTER_USE_TESTS)

    ALL_DATASETS = [ds_procurement, ds_warehouse, ds_logistics, ds_computer_use]
    ALL_TESTCASES = tc_procurement + tc_warehouse + tc_logistics + tc_computer_use

    # ── Risk tiers on datasets (Analytics Hub Phase 1) ──
    risk_tiers = ["tier_1_critical", "tier_1_critical", "tier_2_important", "tier_2_important", "tier_3_routine"]
    for ds, tier in zip(ALL_DATASETS, risk_tiers[:len(ALL_DATASETS)]):
        ds["risk_tier"] = tier
    # Ensure CU dataset has a tier if not already covered
    if "risk_tier" not in ds_computer_use:
        ds_computer_use["risk_tier"] = "tier_2_important"

    AGENT_DATASETS = {
        "Procurement Agent":            [("procurement", ds_procurement, tc_procurement)],
        "Warehouse Manager":            [("warehouse",   ds_warehouse,   tc_warehouse)],
        "Logistics Coordinator":        [("logistics",   ds_logistics,   tc_logistics)],
        "Demand Forecaster":            [("logistics",   ds_logistics,   tc_logistics)],
        "Supplier Relationship Manager":[("procurement", ds_procurement, tc_procurement)],
        "Quality Inspector":            [("warehouse",   ds_warehouse,   tc_warehouse)],
        "Order Fulfillment Agent":      [("warehouse",   ds_warehouse,   tc_warehouse)],
        "Customs & Trade Compliance":   [("logistics",   ds_logistics,   tc_logistics)],
        "Fleet Manager":                [("logistics",   ds_logistics,   tc_logistics)],
        "Returns & Reverse Logistics":  [("warehouse",   ds_warehouse,   tc_warehouse)],
        "Computer Use Agent":           [("computer_use", ds_computer_use, tc_computer_use)],
    }

    # ── Prompts ──
    PROMPT_TEMPLATES = {
        "Procurement Agent": [
            (1, "Initial - basic PO handling",
             "You are a procurement agent for an industrial manufacturing company.\nProcess purchase requests and create purchase orders.\nLook up supplier information when needed."),
            (2, "Added spend controls + risk assessment",
             "You are a procurement agent for an industrial manufacturing company.\nRules:\n1. Check budget availability before creating POs\n2. Route POs above €50K to VP for approval\n3. For emergency procurement, identify at least 2 alternative suppliers\n4. Flag contracts with unfavorable escalation clauses\n5. Apply total cost of ownership analysis (include freight, duties, quality costs)\n6. Verify supplier compliance certificates are current"),
            (3, "Multi-tier risk + negotiation support",
             "You are a procurement agent for an industrial manufacturing company.\nRules:\n1. Check budget before POs; route >€50K to VP\n2. Emergency procurement: 2+ alternatives, expedited approval path\n3. Flag unfavorable contract terms (uncapped escalation, auto-renewal >1yr, unlimited liability)\n4. Total cost of ownership: include freight, duties, quality, inventory carrying costs\n5. Verify supplier compliance (ISO 9001, conflict minerals, REACH)\n6. Assess multi-tier supply risk when disruption reported\n7. Support MOQ negotiation with volume commitment projections\n8. Track spend against category budgets, alert at 85% threshold"),
        ],
        "Warehouse Manager": [
            (1, "Basic inventory tracking", "You are a warehouse manager. Track inventory levels and manage storage locations."),
            (2, "Zone compliance + FIFO + discrepancy handling",
             "You are a warehouse manager for a manufacturing distribution center.\n1. Assign storage by product class (hazmat zones, ESD-safe, temperature-controlled)\n2. Enforce FIFO lot rotation\n3. Flag cycle count variances above 5% for investigation\n4. Cross-dock perishable or time-sensitive items when outbound order exists\n5. Verify inbound quantities against PO"),
        ],
        "Logistics Coordinator": [
            (1, "Basic shipment tracking", "You are a logistics coordinator. Track shipments and coordinate deliveries."),
            (2, "Route optimization + carrier SLA management",
             "You are a logistics coordinator for European supply chain operations.\n1. Optimize routes considering cost, time, and carbon footprint\n2. Multi-modal options when delivery window allows\n3. Monitor carrier SLA compliance\n4. Apply penalty clauses per contract terms\n5. Temperature excursions: immediate driver contact + incident report\n6. Audit freight invoices against contracted rates"),
            (3, "Full compliance + contingency planning",
             "You are a logistics coordinator for European supply chain operations.\n1. Optimize routes: cost, time, carbon, and risk\n2. Multi-modal options when window allows (truck+rail preferred for >1000km)\n3. Carrier SLA: escalate after 2nd breach, activate backup carrier on 3rd\n4. Penalty clauses per contract, formal dispute memo for overcharges\n5. Cold chain: immediate response to excursions, deviation reports\n6. Freight audit: flag any line item >5% above contracted rate\n7. Customs: verify HS codes, apply preferential tariffs where eligible\n8. Last-mile: optimize by vehicle type and time-window constraints"),
        ],
        "Demand Forecaster": [
            (1, "Basic demand prediction", "You are a demand forecaster. Analyze historical data and predict future demand."),
            (2, "Seasonal adjustment + safety stock",
             "You are a demand forecaster for manufacturing supply chain.\n1. Weight customer forecasts by historical accuracy\n2. Apply seasonal multipliers from 2+ years of history\n3. Calculate safety stock based on lead time and demand variability\n4. Flag SKUs with coefficient of variation >0.3 for manual review\n5. Pre-build recommendations 6 weeks before peak season"),
        ],
        "Supplier Relationship Manager": [
            (1, "Basic supplier communication", "You are a supplier relationship manager. Communicate with suppliers and track performance."),
            (2, "Scorecard management + compliance tracking",
             "You are a supplier relationship manager.\n1. Maintain supplier scorecards: quality, delivery, price, responsiveness\n2. Track compliance certifications and expiration dates\n3. Conduct quarterly business reviews\n4. Escalate quality issues with evidence\n5. Validate onboarding documentation completeness"),
        ],
        "Quality Inspector": [
            (1, "Basic inspection", "You are a quality inspector. Check incoming goods for defects and compliance."),
            (2, "Statistical sampling + CAPA integration",
             "You are a quality inspector for incoming goods.\n1. Apply AQL sampling per ISO 2859-1 based on lot size\n2. Log non-conformances with photos and measurements\n3. Initiate CAPA for recurring defects (3+ occurrences)\n4. Quarantine lots failing critical dimensions\n5. Issue supplier quality notifications within 24 hours"),
        ],
        "Order Fulfillment Agent": [
            (1, "Basic order processing", "You are an order fulfillment agent. Process customer orders and schedule deliveries."),
            (2, "Priority allocation + customer notification",
             "You are an order fulfillment agent.\n1. Allocate stock by priority: A (critical/overdue) > B (standard) > C (forecast)\n2. Partial fills allowed with customer notification\n3. Generate optimized pick lists across warehouse zones\n4. ESD-sensitive items: flag for special handling\n5. Backorder queue: auto-allocate on stock receipt"),
        ],
        "Customs & Trade Compliance": [
            (1, "Basic documentation", "You are a customs and trade compliance agent. Prepare customs documents for international shipments."),
            (2, "Tariff optimization + sanctions screening",
             "You are a customs and trade compliance specialist.\n1. Classify goods using correct HS codes (6-digit minimum)\n2. Apply preferential tariff rates under applicable trade agreements\n3. Screen all parties against sanctions lists (EU, OFAC)\n4. Prepare complete customs packages\n5. Calculate duties and taxes for landed cost estimation"),
        ],
        "Fleet Manager": [
            (1, "Basic vehicle tracking", "You are a fleet manager. Track vehicles and schedule maintenance."),
            (2, "Predictive maintenance + driver optimization",
             "You are a fleet manager for a logistics company.\n1. Schedule preventive maintenance by mileage AND time intervals\n2. Flag vehicles approaching service threshold before long routes\n3. Assign backup vehicles for critical deliveries\n4. Track fuel consumption anomalies\n5. Optimize driver hours to comply with EU driving time regulations"),
        ],
        "Returns & Reverse Logistics": [
            (1, "Basic returns processing", "You are a returns agent. Process customer returns and issue credits."),
            (2, "Inspection-based disposition + batch tracking",
             "You are a returns and reverse logistics agent.\n1. Receive RMA, verify against original order\n2. Inspect sample (min 20%) under original test conditions\n3. Classify: restock (A-grade), rework, scrap\n4. Issue credit or replacement based on inspection results\n5. Flag potential batch-wide issues to quality team\n6. Track return rates by SKU and customer"),
        ],
        "Computer Use Agent": [
            (1, "Basic browser navigation",
             "You are a browser automation agent. Navigate to web pages and extract information.\nUse the navigate tool to go to URLs, read_page_text to extract content, and done to report results."),
            (2, "Multi-step interaction + error recovery",
             "You are a browser automation agent that interacts with web applications.\nRules:\n1. Navigate to the requested URL first\n2. Use read_page_text to understand page content before interacting\n3. For forms: use click to select elements, type_text to fill fields\n4. Handle errors gracefully: if a page fails to load, try alternative URLs\n5. When extracting information, be specific and include exact numbers/text\n6. Complete multi-step tasks in logical order\n7. Report findings using the done tool with a clear, structured response"),
            (3, "Advanced automation + verification",
             "You are an expert browser automation agent that completes web tasks reliably.\nRules:\n1. Navigate to URLs and verify the page loaded correctly\n2. Read page content before and after interactions to verify changes\n3. For multi-page tasks: track which pages you've visited and what data you collected\n4. Form interaction: fill all required fields, select correct options, verify submission\n5. Error recovery: detect 404/500 errors, blank pages, and navigation failures; try alternatives\n6. Data extraction: provide precise, formatted data (numbers, dates, proper nouns)\n7. Cross-reference information from multiple pages when required\n8. Report confidence level if information might be outdated or ambiguous"),
        ],
    }

    ALL_PROMPTS = []
    for agent in AGENTS:
        versions = PROMPT_TEMPLATES.get(agent["name"], [])
        for v, notes, prompt_text in versions:
            created = BASE_DATE - timedelta(days=14) + timedelta(days=(v - 1) * 5, hours=random.randint(0, 8))
            ALL_PROMPTS.append({
                "id": _uid("prompt"), "agent_id": agent["id"],
                "system_prompt": prompt_text, "version": v,
                "created_at": _ts(created), "notes": notes,
                "is_active": v == len(versions),
            })

    # ── Test difficulty + version boosts ──
    TEST_DIFFICULTY = {}
    for td in PROCUREMENT_TESTS + WAREHOUSE_TESTS + LOGISTICS_TESTS + COMPUTER_USE_TESTS:
        if td.get("holdout"):
            TEST_DIFFICULTY[td["name"]] = random.uniform(0.25, 0.40)
        elif len(td.get("tools", [])) >= 4:
            TEST_DIFFICULTY[td["name"]] = random.uniform(0.35, 0.55)
        elif len(td.get("tools", [])) >= 3:
            TEST_DIFFICULTY[td["name"]] = random.uniform(0.45, 0.65)
        else:
            TEST_DIFFICULTY[td["name"]] = random.uniform(0.55, 0.90)

    VERSION_BOOST = {}
    for agent in AGENTS:
        versions = PROMPT_TEMPLATES.get(agent["name"], [])
        boosts = {1: 0.0}
        for v, _, _ in versions[1:]:
            boosts[v] = boosts.get(v - 1, 0) + random.uniform(0.10, 0.22)
        VERSION_BOOST[agent["name"]] = boosts

    TOOLS_DB = {
        "create_rfq": ["item", "quantity", "suppliers", "delivery_date"],
        "lookup_supplier": ["supplier_name_or_id"],
        "create_purchase_order": ["item", "quantity", "supplier", "price"],
        "check_budget": ["category", "amount"],
        "route_approval": ["po_id", "approver_level"],
        "validate_documents": ["supplier_id", "doc_type"],
        "calculate_total_cost": ["items", "include_duties"],
        "read_document": ["document_id"],
        "create_report": ["title", "findings"],
        "send_notification": ["to", "subject", "body"],
        "send_alert": ["channel", "message", "severity"],
        "escalate_to_lead": ["priority", "reason"],
        "check_compliance": ["entity_id", "regulation"],
        "verify_shipment": ["po_id", "manifest"],
        "update_inventory": ["sku", "quantity", "location"],
        "assign_storage": ["sku", "zone", "bin"],
        "create_discrepancy_report": ["po_id", "variance"],
        "generate_pick_list": ["order_id"],
        "check_inventory": ["sku_or_item"],
        "create_shipment": ["order_id", "carrier"],
        "print_labels": ["shipment_id"],
        "query_transactions": ["sku", "date_range"],
        "create_adjustment": ["sku", "quantity", "reason"],
        "check_orders": ["item", "status"],
        "assign_dock": ["dock_id", "shipment_id"],
        "allocate_stock": ["sku", "order_id", "quantity"],
        "update_orders": ["order_id", "status"],
        "check_storage_rules": ["material_class", "zone"],
        "update_pick_priority": ["lot_id", "priority"],
        "process_return": ["rma_id"],
        "inspect_quality": ["sku", "sample_size"],
        "calculate_route": ["origin", "destination", "mode"],
        "compare_carriers": ["lane", "weight"],
        "optimize_route": ["stops", "constraints"],
        "assign_vehicle": ["vehicle_id", "route"],
        "assign_driver": ["driver_id", "vehicle_id"],
        "classify_tariff": ["product", "origin_country"],
        "generate_customs_docs": ["shipment_id", "doc_type"],
        "query_shipment_history": ["carrier", "date_range"],
        "calculate_penalties": ["carrier", "breaches"],
        "create_dispute": ["invoice_id", "line_items"],
        "check_shipment_status": ["container_id"],
        "contact_driver": ["vehicle_id", "message"],
        "create_incident": ["title", "severity"],
        "check_vehicle_status": ["vehicle_id"],
        "schedule_maintenance": ["vehicle_id", "service_type"],
        "analyze_demand_history": ["sku_group", "period"],
        "calculate_safety_stock": ["sku", "lead_time", "demand_variability"],
        "create_forecast": ["sku_group", "horizon"],
        "verify_invoice": ["invoice_id", "contract_id"],
        # Computer Use Agent tools
        "navigate": ["url"],
        "click": ["x", "y"],
        "type_text": ["text"],
        "press_key": ["key"],
        "scroll": ["direction", "amount"],
        "read_page_text": [],
        "done": ["response"],
    }

    # ── CUA-realistic tool call data keyed by test name ─────────────────
    # Maps test name → list of step dicts matching the real agent's
    # to_tool_calls() format (name, arguments, result, success, reasoning,
    # step_number, duration_seconds).
    import re as _re

    def _extract_urls(text):
        """Pull http(s) URLs out of a task input string."""
        return _re.findall(r'https?://[^\s,\'"]+', text)

    CUA_STEP_TEMPLATES = {
        "Wikipedia: Country Population": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Navigating to the Wikipedia article about France to find its population.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.8, 3.5), 2)},
            {"name": "scroll", "arguments": {"direction": "down", "amount": 2},
             "result": "Scrolled down. Position: 25%", "success": True,
             "reasoning": "Scrolling to find the population information in the infobox.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.8, 1.5), 2)},
            {"name": "done",
             "arguments": {"result": "The population of France is approximately 68,170,228." if passed
                           else "I was unable to find the population figure.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "Found the population figure in the infobox and reporting it." if passed
                          else "Could not locate the population field on the page.",
             "step_number": 3, "duration_seconds": 0.0},
        ],
        "Wikipedia: Capital City": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the Wikipedia article about Japan.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 3.0), 2)},
            {"name": "done",
             "arguments": {"result": "The capital of Japan is Tokyo." if passed
                           else "The page did not load correctly.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The capital city is clearly stated in the opening sentence." if passed
                          else "Failed to extract information from the page.",
             "step_number": 2, "duration_seconds": 0.0},
        ],
        "Hacker News: Top Story": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening Hacker News front page to find the #1 story.",
             "step_number": 1, "duration_seconds": round(random.uniform(2.0, 4.0), 2)},
            {"name": "read_page_text", "arguments": {},
             "result": "Page text:\n1. Show HN: A new open-source project for…\n2. Why Rust is…",
             "success": True,
             "reasoning": "Reading the page text to identify the top story title.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "done",
             "arguments": {"result": "The #1 story on Hacker News is: 'Show HN: A new open-source project for distributed systems'" if passed
                           else "Could not determine the top story.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "Extracted the first story title from the page text." if passed
                          else "The page content was hard to parse.",
             "step_number": 3, "duration_seconds": 0.0},
        ],
        "GitHub: Repository Info": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the GitHub repository page.",
             "step_number": 1, "duration_seconds": round(random.uniform(2.0, 4.0), 2)},
            {"name": "read_page_text", "arguments": {},
             "result": "Page text:\nanthropics/anthropic-cookbook\nA collection of notebooks and recipes…\nJupyter Notebook 78.2%  Python 21.8%",
             "success": True,
             "reasoning": "Reading the page to find the repository description and language breakdown.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "done",
             "arguments": {"result": "The repository description is 'A collection of notebooks/recipes for the Anthropic API'. The primary language is Jupyter Notebook (78.2%), followed by Python (21.8%)." if passed
                           else "I could not read the repository description.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "Found both the about text and language breakdown on the page." if passed
                          else "Page structure was unclear.",
             "step_number": 3, "duration_seconds": 0.0},
        ],
        "Wikipedia: Direct Lookup": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Navigating to the Claude Shannon Wikipedia article.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 3.0), 2)},
            {"name": "scroll", "arguments": {"direction": "down", "amount": 1},
             "result": "Scrolled down. Position: 15%", "success": True,
             "reasoning": "Scrolling to see more of the article for birth year and contributions.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.5, 1.2), 2)},
            {"name": "done",
             "arguments": {"result": "Claude Shannon was born on April 30, 1916. His main contribution was founding information theory, published in 'A Mathematical Theory of Communication' (1948)." if passed
                           else "I found the article but couldn't extract the specific dates.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The birth year and main contribution are in the opening paragraphs." if passed
                          else "The page content was too long to parse effectively.",
             "step_number": 3, "duration_seconds": 0.0},
        ],
        "Wikipedia: Programming Language": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the Python programming language Wikipedia article.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 3.5), 2)},
            {"name": "done",
             "arguments": {"result": "Python was first released in 1991 and was designed by Guido van Rossum." if passed
                           else "The page loaded but I couldn't parse the release year.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The designer and release year are stated in the article's infobox and first paragraph." if passed
                          else "The infobox fields were not easily identifiable.",
             "step_number": 2, "duration_seconds": 0.0},
        ],
        "Form Interaction": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the httpbin form page to fill in customer details.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 2.5), 2)},
            {"name": "click", "arguments": {"x": 340, "y": 192},
             "result": "Clicked (340, 192)", "success": True,
             "reasoning": "Clicking on the customer name input field to focus it.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "type_text", "arguments": {"text": "POST Test"},
             "result": "Typed 'POST Test'", "success": True,
             "reasoning": "Typing the customer name as specified in the task.",
             "step_number": 3, "duration_seconds": round(random.uniform(0.5, 1.0), 2)},
            {"name": "click", "arguments": {"x": 280, "y": 295},
             "result": "Clicked (280, 295)", "success": True,
             "reasoning": "Selecting the 'Medium' pizza size radio button.",
             "step_number": 4, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "click", "arguments": {"x": 350, "y": 490},
             "result": "Clicked (350, 490)", "success": True if passed else False,
             "reasoning": "Clicking the Submit Order button." if passed
                          else "Clicking what I think is the submit button.",
             "step_number": 5, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "done",
             "arguments": {"result": "Form submitted successfully. The response shows: custname=POST Test, size=medium." if passed
                           else "I clicked submit but the page did not show confirmation.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The form response page confirms the submitted data." if passed
                          else "Could not verify that the form was submitted successfully.",
             "step_number": 6, "duration_seconds": 0.0},
        ],
        "Error Recovery": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 404", "success": True,
             "reasoning": "Navigating to the 404 page as instructed.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 2.5), 2)},
            {"name": "read_page_text", "arguments": {},
             "result": "Page text: (empty or blank page)", "success": True,
             "reasoning": "Reading the page to confirm it shows a 404 error or blank content.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.2, 0.5), 2)},
            {"name": "navigate", "arguments": {"url": urls[1] if len(urls) > 1 else "https://httpbin.org/html"},
             "result": f"Navigated to {urls[1] if len(urls) > 1 else 'https://httpbin.org/html'}, status 200",
             "success": True,
             "reasoning": "The page was blank/404. Navigating to the fallback URL as instructed.",
             "step_number": 3, "duration_seconds": round(random.uniform(1.5, 2.5), 2)},
            {"name": "done",
             "arguments": {"result": "The fallback page at httpbin.org/html contains a passage from Herman Melville's Moby Dick, rendered as styled HTML." if passed
                           else "I navigated to the fallback page but couldn't read its content.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The HTML page displays a classic literature passage which I've described." if passed
                          else "Had trouble reading the content on the fallback page.",
             "step_number": 4, "duration_seconds": 0.0},
        ],
        "AgentEval: Read Analytics": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the AgentEval analytics dashboard.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 3.0), 2)},
            {"name": "scroll", "arguments": {"direction": "down", "amount": 2},
             "result": "Scrolled down. Position: 40%", "success": True,
             "reasoning": "Scrolling to see all sections of the analytics dashboard.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.5, 1.0), 2)},
            {"name": "done",
             "arguments": {"result": "The Analytics dashboard shows: Pass Rate Trends chart, Agent Performance comparison, Dataset Coverage metrics, and Recent Evaluation Runs table." if passed
                           else "The page loaded but appeared mostly empty.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "Identified the main dashboard sections visible on the page." if passed
                          else "The dashboard did not render properly.",
             "step_number": 3, "duration_seconds": 0.0},
        ],
        "AgentEval: List Agents": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the AgentEval agents listing page.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 3.0), 2)},
            {"name": "done",
             "arguments": {"result": "Agents registered: Procurement Agent, Warehouse Manager, Logistics Coordinator, Demand Forecaster, Supplier Relationship Manager, Quality Inspector, Order Fulfillment Agent, Customs & Trade Compliance, Fleet Manager, Returns & Reverse Logistics, Computer Use Agent." if passed
                           else "Could not read the agents list from the page.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "Listed all agent names visible on the page." if passed
                          else "The page content was not readable.",
             "step_number": 2, "duration_seconds": 0.0},
        ],
        "Wikipedia: Table Reading": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the Wikipedia list of largest cities page.",
             "step_number": 1, "duration_seconds": round(random.uniform(2.0, 4.0), 2)},
            {"name": "scroll", "arguments": {"direction": "down", "amount": 3},
             "result": "Scrolled down. Position: 30%", "success": True,
             "reasoning": "Scrolling to find the main population table.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.5, 1.2), 2)},
            {"name": "read_page_text", "arguments": {},
             "result": "Page text:\nList of largest cities\n…\nRank  City  Country  Population\n1  Tokyo  Japan  13,960,000…",
             "success": True,
             "reasoning": "Reading the table data to find the largest city.",
             "step_number": 3, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "done",
             "arguments": {"result": "According to the table, Tokyo, Japan is the largest city by population with approximately 13,960,000 people." if passed
                           else "I found a table but couldn't reliably determine the largest city.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The table clearly shows Tokyo as the top entry." if passed
                          else "The table structure was difficult to parse from the page text.",
             "step_number": 4, "duration_seconds": 0.0},
        ],
        "httpbin: Headers Inspection": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the httpbin headers endpoint to see request headers.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 2.5), 2)},
            {"name": "done",
             "arguments": {"result": "The User-Agent header shown is: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36" if passed
                           else "The page showed JSON but I couldn't parse the User-Agent.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The headers are displayed as JSON on the page, easily readable." if passed
                          else "The JSON output was not clearly formatted.",
             "step_number": 2, "duration_seconds": 0.0},
        ],
        "Wikipedia: Multi-fact Extraction": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the Wikipedia article about the Moon.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 3.0), 2)},
            {"name": "scroll", "arguments": {"direction": "down", "amount": 2},
             "result": "Scrolled down. Position: 20%", "success": True,
             "reasoning": "Scrolling to find the diameter and landing year in the article.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.5, 1.0), 2)},
            {"name": "done",
             "arguments": {"result": "The Moon's diameter is 3,474.8 km. The first crewed lunar landing was Apollo 11 in 1969." if passed
                           else "I found the diameter but couldn't locate the landing year.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "Both facts are in the article's infobox and early paragraphs." if passed
                          else "Only found partial information.",
             "step_number": 3, "duration_seconds": 0.0},
        ],
        "GitHub: Stars and License": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the VS Code GitHub repository page.",
             "step_number": 1, "duration_seconds": round(random.uniform(2.0, 4.0), 2)},
            {"name": "read_page_text", "arguments": {},
             "result": "Page text:\nmicrosoft/vscode\nVisual Studio Code\n★ 171k\nLicense: MIT\n…",
             "success": True,
             "reasoning": "Reading the repository metadata to find star count and license.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "done",
             "arguments": {"result": "The VS Code repository has approximately 171,000 stars and uses the MIT License." if passed
                           else "I could see the star count but the license was not visible.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "Both the star count and license are visible on the repo page." if passed
                          else "The license information was not in the visible area.",
             "step_number": 3, "duration_seconds": 0.0},
        ],
        "Form Interaction: Radio and Checkbox": lambda urls, passed: [
            {"name": "navigate", "arguments": {"url": urls[0]},
             "result": f"Navigated to {urls[0]}, status 200", "success": True,
             "reasoning": "Opening the httpbin form page.",
             "step_number": 1, "duration_seconds": round(random.uniform(1.5, 2.5), 2)},
            {"name": "click", "arguments": {"x": 340, "y": 192},
             "result": "Clicked (340, 192)", "success": True,
             "reasoning": "Clicking on the customer name input field.",
             "step_number": 2, "duration_seconds": round(random.uniform(0.3, 0.6), 2)},
            {"name": "type_text", "arguments": {"text": "Holdout Test"},
             "result": "Typed 'Holdout Test'", "success": True,
             "reasoning": "Entering the customer name as specified.",
             "step_number": 3, "duration_seconds": round(random.uniform(0.4, 0.8), 2)},
            {"name": "click", "arguments": {"x": 280, "y": 320},
             "result": "Clicked (280, 320)", "success": True,
             "reasoning": "Selecting the 'Large' pizza size radio button.",
             "step_number": 4, "duration_seconds": round(random.uniform(0.3, 0.6), 2)},
            {"name": "click", "arguments": {"x": 260, "y": 380},
             "result": "Clicked (260, 380)", "success": True,
             "reasoning": "Checking the 'Mushrooms' topping checkbox.",
             "step_number": 5, "duration_seconds": round(random.uniform(0.3, 0.6), 2)},
            {"name": "click", "arguments": {"x": 260, "y": 410},
             "result": "Clicked (260, 410)", "success": True,
             "reasoning": "Checking the 'Onions' topping checkbox.",
             "step_number": 6, "duration_seconds": round(random.uniform(0.3, 0.6), 2)},
            {"name": "click", "arguments": {"x": 350, "y": 490},
             "result": "Clicked (350, 490)", "success": True if passed else False,
             "reasoning": "Clicking the Submit Order button.",
             "step_number": 7, "duration_seconds": round(random.uniform(0.3, 0.8), 2)},
            {"name": "done",
             "arguments": {"result": "Form submitted. Response shows: custname=Holdout Test, size=large, topping=mushrooms, topping=onions." if passed
                           else "Clicked submit but the response page was unclear.", "success": passed},
             "result": "Task completed" if passed else "Task completed with errors",
             "success": passed,
             "reasoning": "The submission response confirms all form fields were correctly set." if passed
                          else "Could not verify the form submission data.",
             "step_number": 8, "duration_seconds": 0.0},
        ],
    }

    def gen_tool_calls(tc, passed):
        tools = tc.get("minimal_tool_set", [])
        if not tools:
            return []

        # CUA browser tests: use realistic step templates
        tc_name = tc.get("name", "")
        if tc_name in CUA_STEP_TEMPLATES:
            urls = _extract_urls(tc.get("input", ""))
            steps = CUA_STEP_TEMPLATES[tc_name](urls, passed)
            # For failed runs, optionally drop or corrupt a middle step
            if not passed and len(steps) > 2 and random.random() > 0.5:
                # Remove a random intermediate step (not first navigate or last done)
                drop_idx = random.randint(1, len(steps) - 2)
                steps.pop(drop_idx)
                # Re-number remaining steps
                for i, s in enumerate(steps):
                    s["step_number"] = i + 1
            return steps

        # Supply-chain / generic tests: keep existing format
        calls = []
        for t in tools:
            params = TOOLS_DB.get(t, [])
            calls.append({"name": t, "input_parameters": {p: f"<{p}_val>" for p in params},
                           "result": "success" if (passed or random.random() > 0.3) else "error"})
        if not passed and random.random() > 0.65:
            calls.append({"name": random.choice(list(TOOLS_DB.keys())),
                           "input_parameters": {"error": "wrong_tool"}, "result": "error"})
        return calls

    def gen_tc_result(tc, passed, base_dt):
        a_dur = round(random.uniform(1.2, 9.0), 2)
        j_dur = round(random.uniform(0.4, 3.5), 2)
        t_dur = round(a_dur + j_dur + random.uniform(0.1, 0.4), 2)
        tool_exps = tc.get("tool_expectations", [])
        res_te = []
        for te in tool_exps:
            args = []
            for arg in te.get("arguments", []):
                asserts = [{"passed": passed or random.random() > 0.4,
                            "llm_judge_output": f"{'OK' if passed else 'FAIL'}: {a}"}
                           for a in arg.get("assertion", [])]
                args.append({"name_of_argument": arg["name"], "assertions": asserts})
            res_te.append({"name_of_tool": te["name"], "arguments": args})

        exp_tools = [{"name_of_tool": t, "was_called": passed or random.random() > 0.3}
                     for t in tc.get("minimal_tool_set", [])]

        # Determine failure mode for failed test cases
        failure_mode = None
        if not passed:
            failure_modes = ["tool_not_called", "wrong_tool", "wrong_args", "hallucination", "partial_match"]
            mode_weights = [0.15, 0.10, 0.30, 0.20, 0.25]
            failure_mode = random.choices(failure_modes, weights=mode_weights, k=1)[0]

        return {
            "testcase_id": tc["id"], "passed": passed,
            "response_from_agent": f"{'Correct' if passed else 'Incorrect'} response for {tc['name']}",
            "expected_tools": exp_tools, "tool_expectations": res_te,
            "response_quality_assertion": {"passed": passed,
                "llm_judge_output": f"Response {'meets' if passed else 'fails'} expectations."},
            "actual_tool_calls": gen_tool_calls(tc, passed),
            "execution_error": None if passed or random.random() > 0.12 else "Timeout",
            "retry_count": 0 if passed else random.choice([0,0,0,1,1,2]),
            "completed_at": _ts(base_dt + timedelta(seconds=t_dur)),
            "agent_call_duration_seconds": a_dur, "judge_call_duration_seconds": j_dur,
            "total_duration_seconds": t_dur,
            "failure_mode": failure_mode,
        }

    # ── Judge Configs (defined before evaluations so gen_eval can reference them) ──
    # Two configs: a binary default (v1) and a rubric-based advanced (v2, active)
    JUDGE_CONFIGS = []
    jcfg_id = "supply_chain_judge"
    jcfg_created_v1 = _ts(BASE_DATE - timedelta(days=6))
    jcfg_created_v2 = _ts(BASE_DATE + timedelta(days=4))
    ACTIVE_JUDGE_ID = jcfg_id
    ACTIVE_JUDGE_VERSION = 2

    # v1: Binary mode — mirrors the original hard-coded defaults
    JUDGE_CONFIGS.append({
        "id": jcfg_id, "name": "Supply Chain Judge", "version": 1, "is_active": False,
        "system_prompt": (
            "You are a precise evaluator for supply-chain AI agents. "
            "Assess each assertion objectively and return ONLY valid JSON. "
            "Keep each reasoning to ONE sentence. "
            "Return passed=true only if the assertion is clearly satisfied."
        ),
        "user_prompt_template_batched": (
            "You are evaluating multiple assertions about an AI agent's tool usage in a single pass.\n\n"
            "**Test Context:**\n- Input: {{test_input}}\n- Description: {{test_description}}\n\n"
            "**Tool:** {{tool_name}}\n**Agent's Tool Calls:** {{tool_calls_json}}\n"
            "**Actual Tools Used:** {{actual_tools}}\n\n"
            "**Assertions to evaluate (evaluate ALL of them):**\n{{assertions_block}}\n\n"
            "**Task:** For EACH assertion, determine if it is satisfied (true/false) "
            "with a one-sentence explanation.\n\n"
            "Respond with ONLY a JSON object containing a \"results\" array, "
            "one entry per assertion in the SAME ORDER:\n"
            "{\"results\": [{\"index\": 0, \"passed\": true, \"reasoning\": \"One sentence.\"}]}"
        ),
        "user_prompt_template_single": (
            "You are evaluating a specific assertion about an AI agent's performance.\n\n"
            "**Test Context:**\n- Input: {{test_input}}\n- Description: {{test_description}}\n\n"
            "{{assertion_context}}\n\n"
            "**Task:** Determine if this assertion is satisfied (True/False).\n\n"
            "Respond in JSON: {\"passed\": true, \"reasoning\": \"One sentence.\"}"
        ),
        "rubric": [], "scoring_mode": "binary", "pass_threshold": None,
        "notes": "Initial binary judge — simple pass/fail for each assertion.",
        "created_at": jcfg_created_v1,
    })

    # v2: Rubric mode — multi-dimensional scoring with supply-chain criteria
    JUDGE_CONFIGS.append({
        "id": jcfg_id, "name": "Supply Chain Judge", "version": 2, "is_active": True,
        "system_prompt": (
            "You are a rigorous evaluator for supply-chain AI agents. "
            "Score each criterion on the provided rubric scale (1-5). "
            "Return ONLY valid JSON. Be precise and cite specific evidence from "
            "the agent's tool calls and response."
        ),
        "user_prompt_template_batched": (
            "You are evaluating an AI agent's tool usage against multiple assertions.\n\n"
            "**Test Context:**\n- Input: {{test_input}}\n- Description: {{test_description}}\n\n"
            "**Tool:** {{tool_name}}\n**Agent's Tool Calls:** {{tool_calls_json}}\n"
            "**Actual Tools Used:** {{actual_tools}}\n\n{{rubric}}\n\n"
            "**Assertions to evaluate (evaluate ALL of them):**\n{{assertions_block}}\n\n"
            "**Task:** For EACH assertion, determine if it is satisfied (true/false) "
            "with a one-sentence explanation citing specific evidence.\n\n"
            "Respond with ONLY a JSON object:\n"
            "{\"results\": [{\"index\": 0, \"passed\": true, \"reasoning\": \"Evidence-based.\"}]}"
        ),
        "user_prompt_template_single": (
            "You are evaluating a specific assertion about a supply-chain AI agent.\n\n"
            "**Test Context:**\n- Input: {{test_input}}\n- Description: {{test_description}}\n\n"
            "{{rubric}}\n\n{{assertion_context}}\n\n"
            "**Task:** Determine if this assertion is satisfied (True/False). "
            "Cite specific evidence from the agent's actions.\n\n"
            "Respond in JSON: {\"passed\": true, \"reasoning\": \"Evidence-based.\"}"
        ),
        "rubric": [
            {"name": "tool_selection",
             "description": "Did the agent choose the correct tools for the task?",
             "levels": [
                 {"score": 1, "description": "Called no relevant tools or used entirely wrong tools"},
                 {"score": 2, "description": "Called some relevant tools but missed critical ones"},
                 {"score": 3, "description": "Called the right tools but in wrong order or with unnecessary extras"},
                 {"score": 4, "description": "Correct tools selected with minor inefficiency"},
                 {"score": 5, "description": "Optimal tool selection — correct tools, right order, nothing extraneous"},
             ]},
            {"name": "parameter_accuracy",
             "description": "Were the tool parameters correct and complete?",
             "levels": [
                 {"score": 1, "description": "Parameters missing or completely wrong"},
                 {"score": 2, "description": "Some parameters correct but critical ones wrong or missing"},
                 {"score": 3, "description": "Most parameters correct but minor errors present"},
                 {"score": 4, "description": "All required parameters correct with minor format issues"},
                 {"score": 5, "description": "All parameters exactly correct with proper formatting and units"},
             ]},
            {"name": "compliance_awareness",
             "description": "Did the agent respect regulatory, safety, and process compliance?",
             "levels": [
                 {"score": 1, "description": "Ignored compliance requirements entirely"},
                 {"score": 2, "description": "Acknowledged compliance but applied incorrectly"},
                 {"score": 3, "description": "Met basic compliance but missed edge cases"},
                 {"score": 4, "description": "Strong compliance handling with minor omissions"},
                 {"score": 5, "description": "Full compliance: flagged risks, applied correct regulations, documented properly"},
             ]},
            {"name": "escalation_judgment",
             "description": "Did the agent escalate appropriately when human intervention was needed?",
             "levels": [
                 {"score": 1, "description": "Failed to escalate a critical situation"},
                 {"score": 2, "description": "Escalated but to wrong person/channel or too late"},
                 {"score": 3, "description": "Correct escalation but missing context in the notification"},
                 {"score": 4, "description": "Proper escalation with good context and timing"},
                 {"score": 5, "description": "Perfect escalation: right person, right time, full context, and suggested actions"},
             ]},
            {"name": "response_completeness",
             "description": "Did the agent's response cover all aspects of the request?",
             "levels": [
                 {"score": 1, "description": "Response addressed less than 30% of the request"},
                 {"score": 2, "description": "Partial response, missed major components"},
                 {"score": 3, "description": "Covered core request but missed secondary requirements"},
                 {"score": 4, "description": "Comprehensive response with minor gaps"},
                 {"score": 5, "description": "Complete response covering all explicit and implicit requirements"},
             ]},
        ],
        "scoring_mode": "rubric", "pass_threshold": 3.5,
        "notes": "Rubric-based judge with 5 supply-chain criteria. Pass threshold 3.5/5 avg.",
        "created_at": jcfg_created_v2,
    })

    # v3: Computer Use Judge — specialized for browser automation evaluation
    cu_judge_created = _ts(BASE_DATE + timedelta(days=2))
    JUDGE_CONFIGS.append({
        "id": "computer_use_judge", "name": "Computer Use Judge", "version": 1, "is_active": True,
        "system_prompt": (
            "You are an expert judge evaluating a computer use agent's performance on web automation tasks. "
            "When evaluating tool argument assertions, focus ONLY on whether the tool call arguments match the assertion. "
            "Do NOT consider whether the agent's final response was correct — that is evaluated separately. "
            "Return ONLY valid JSON. Be strict but fair."
        ),
        "user_prompt_template_batched": (
            "You are evaluating a browser automation agent's tool usage.\n\n"
            "**Task Input:** {{test_input}}\n\n"
            "**Tool:** {{tool_name}}\n"
            "**Agent's Tool Calls:** {{tool_calls_json}}\n"
            "**Actual Tools Used:** {{actual_tools}}\n\n"
            "**Assertions to evaluate (focus ONLY on tool arguments, ignore response quality):**\n"
            "{{assertions_block}}\n\n"
            "For EACH assertion, determine if the agent's tool call arguments satisfy it.\n"
            "Respond with ONLY a JSON object:\n"
            "{\"results\": [{\"index\": 0, \"passed\": true, \"reasoning\": \"Evidence-based.\"}]}"
        ),
        "user_prompt_template_single": (
            "You are evaluating a specific assertion about a browser automation agent.\n\n"
            "**Test Context:**\n"
            "- Input: {{test_input}}\n"
            "- Description: {{test_description}}\n\n"
            "{{assertion_context}}\n\n"
            "**Task:** Determine if this assertion is satisfied (True/False).\n\n"
            "Respond in JSON format with a single human-readable sentence explanation:\n"
            "{\"passed\": true, \"reasoning\": \"One sentence explaining why.\"}"
        ),
        "rubric": [], "scoring_mode": "binary", "pass_threshold": None,
        "notes": "Custom judge for computer use agent evaluation — focuses on task completion accuracy and information extraction quality.",
        "created_at": cu_judge_created,
    })

    # ── Generate evaluations ──
    ALL_EVALS = []

    def gen_eval(agent, ds, tcs, pv, eval_date, suffix=""):
        eval_id = _uid("eval")
        started = _jitter(eval_date, 2)
        boost = VERSION_BOOST.get(agent["name"], {}).get(pv, 0.0)
        results = []
        for tc in tcs:
            if tc["dataset_id"] != ds["id"]:
                continue
            prob = min(TEST_DIFFICULTY.get(tc["name"], 0.5) + boost, 0.96)
            results.append(gen_tc_result(tc, random.random() < prob, started))

        pc = sum(1 for r in results if r["passed"])
        total = len(results)
        rl_hits = random.choice([0,0,0,0, random.randint(1,6)]) if random.random() > 0.5 else 0
        rl_wait = round(rl_hits * random.uniform(5, 25), 1) if rl_hits else 0.0
        t_time = sum(r["total_duration_seconds"] for r in results)
        completed = started + timedelta(seconds=t_time + rl_wait + random.uniform(2, 8))

        sh = [
            {"timestamp": _ts(started - timedelta(seconds=1)), "message": "Created"},
            {"timestamp": _ts(started), "message": "Started"},
        ]
        if rl_hits:
            sh.append({"timestamp": _ts(started + timedelta(seconds=t_time * 0.4)),
                        "message": f"Rate limited {rl_hits}x", "is_rate_limit": True,
                        "retry_attempt": 1, "max_attempts": 5, "wait_seconds": rl_wait})
        sh.append({"timestamp": _ts(completed), "message": "Completed"})

        regs = []
        if pv > 1 and random.random() > 0.55:
            failed = [r for r in results if not r["passed"]]
            for r in random.sample(failed, min(len(failed), random.randint(1, 2))):
                regs.append({"testcase_id": r["testcase_id"], "previous_result": "passed", "current_result": "failed"})

        prompt_objs = [p for p in ALL_PROMPTS if p["agent_id"] == agent["id"] and p["version"] == pv]
        name = f"{ds['seed']['name']} — {agent['name']}"
        if suffix:
            name += f" ({suffix})"

        ev = {
            "id": eval_id, "name": name, "dataset_id": ds["id"], "agent_id": agent["id"],
            "status": "completed", "agent_endpoint": agent["agent_invocation_url"],
            "agent_auth_required": True, "timeout_seconds": 300, "verbose_logging": False,
            "prompt_version": pv, "prompt_id": prompt_objs[0]["id"] if prompt_objs else None,
            "judge_config_id": ACTIVE_JUDGE_ID, "judge_config_version": ACTIVE_JUDGE_VERSION,
            "agent_model": agent.get("model"),  # Capture model for performance tracking
            "total_tests": total, "completed_tests": total, "in_progress_tests": 0,
            "failed_tests": total - pc, "passed_count": pc,
            "created_at": _ts(eval_date), "started_at": _ts(started), "completed_at": _ts(completed),
            "test_cases": results, "regressions": regs,
            "warnings": [f"Rate limited {rl_hits}x"] if rl_hits else [],
            "status_message": None, "status_history": sh,
            "total_rate_limit_hits": rl_hits, "total_retry_wait_seconds": rl_wait,
        }
        ALL_EVALS.append(ev)
        return ev

    for agent in AGENTS:
        datasets = AGENT_DATASETS.get(agent["name"], [])
        versions = PROMPT_TEMPLATES.get(agent["name"], [])
        max_v = len(versions)
        for ds_key, ds, tcs in datasets:
            gen_eval(agent, ds, tcs, 1, BASE_DATE + timedelta(days=random.uniform(0, 1)), "v1 baseline")
            gen_eval(agent, ds, tcs, 1, BASE_DATE + timedelta(days=random.uniform(2, 4)), "v1 recheck")
            if max_v >= 2:
                gen_eval(agent, ds, tcs, 2, BASE_DATE + timedelta(days=random.uniform(5, 6)), "v2 initial")
                gen_eval(agent, ds, tcs, 2, BASE_DATE + timedelta(days=random.uniform(7, 9)), "v2 stable")
            if max_v >= 3:
                gen_eval(agent, ds, tcs, 3, BASE_DATE + timedelta(days=random.uniform(10, 11)), "v3 initial")
                gen_eval(agent, ds, tcs, 3, BASE_DATE + timedelta(days=random.uniform(12, 14)), "v3 latest")
            if agent["name"] in ("Procurement Agent", "Logistics Coordinator", "Warehouse Manager", "Computer Use Agent"):
                gen_eval(agent, ds, tcs, max_v, BASE_DATE + timedelta(days=random.uniform(8, 13)), "extra run")

    # ── Model Comparison Evaluations ──
    # Test selected agents with alternative models to demonstrate model tracking
    MODEL_ALTERNATIVES = {
        "gpt-4o": ["claude-sonnet-4", "gpt-4o-mini"],
        "claude-sonnet-4": ["gpt-4o", "claude-haiku"],
        "gpt-4o-mini": ["gpt-4o", "claude-haiku"],
        "claude-haiku": ["claude-sonnet-4", "gpt-4o-mini"],
    }

    # Select 7 agents for model comparison tests (majority)
    agents_for_model_comparison = [
        "Procurement Agent", "Warehouse Manager", "Logistics Coordinator",
        "Demand Forecaster", "Supplier Relationship Manager",
        "Order Fulfillment Agent", "Customs & Trade Compliance",
        "Computer Use Agent"
    ]

    for agent in AGENTS:
        if agent["name"] not in agents_for_model_comparison:
            continue

        original_model = agent["model"]
        alt_models = MODEL_ALTERNATIVES.get(original_model, [])

        datasets = AGENT_DATASETS.get(agent["name"], [])
        versions = PROMPT_TEMPLATES.get(agent["name"], [])
        max_v = len(versions)

        # Test with 1-2 alternative models
        for alt_idx, alt_model in enumerate(alt_models[:2]):
            # Create a temporary agent dict with the alternative model
            alt_agent = {**agent, "model": alt_model}

            for ds_key, ds, tcs in datasets:
                # Create 2-3 evaluations with the alternative model at different times
                gen_eval(alt_agent, ds, tcs, max_v, BASE_DATE + timedelta(days=random.uniform(15 + alt_idx * 3, 17 + alt_idx * 3)), f"{alt_model} test")
                if random.random() > 0.5:  # 50% chance of second eval with this model
                    gen_eval(alt_agent, ds, tcs, max_v, BASE_DATE + timedelta(days=random.uniform(18 + alt_idx * 3, 20 + alt_idx * 3)), f"{alt_model} retest")

    # ── Annotations ──
    ISSUE_TAGS = [
        "wrong_tool_called", "missing_parameter", "incorrect_calculation",
        "compliance_violation", "incomplete_response", "wrong_supplier_selected",
        "inventory_mismatch", "missed_escalation", "incorrect_classification",
        "wrong_routing", "missing_documentation", "over_promising",
        "safety_oversight", "stale_data_used", "incorrect_prioritization",
    ]

    ALL_RUN_ANNS = []
    ALL_ACTION_ANNS = []

    for ev in ALL_EVALS:
        frac = random.uniform(0.4, 0.85)
        to_annotate = random.sample(ev["test_cases"], max(1, int(len(ev["test_cases"]) * frac)))
        for tc_r in to_annotate:
            p = tc_r["passed"]
            outcome = random.choice([4, 5]) if p else random.choice([1, 2, 3])
            eff = random.choice(["efficient", "acceptable"]) if p else random.choice(["acceptable", "wasteful"])
            issues = [] if p else random.sample(ISSUE_TAGS, random.randint(1, 3))
            ann_dt = datetime.fromisoformat(ev["completed_at"].replace("Z", "+00:00")).replace(tzinfo=timezone.utc) + timedelta(hours=random.randint(1, 36))

            ann = {
                "evaluation_id": ev["id"], "run_id": tc_r["testcase_id"],
                "outcome": outcome, "efficiency": eff, "issues": issues,
                "notes": f"{'Correct handling of supply chain scenario' if p else 'Process gap identified'} — reviewer notes",
                "annotated_by": random.choice(["heinrich", "sofia", "rajesh", "marie", "kenji"]),
                "annotated_at": _ts(ann_dt),
            }
            ann_id = f"{ev['id']}:{tc_r['testcase_id']}"
            ALL_RUN_ANNS.append((ann_id, ev["id"], tc_r["testcase_id"], ann))

            for ai, call in enumerate(tc_r.get("actual_tool_calls", [])):
                corr = "correct" if (p or random.random() > 0.4) else random.choice(["acceptable", "incorrect"])
                pq = "good" if corr == "correct" else random.choice(["suboptimal", "wrong"])
                act_ann = {
                    "evaluation_id": ev["id"], "run_id": tc_r["testcase_id"],
                    "action_index": ai, "correctness": corr, "parameter_quality": pq,
                    "info_utilization": random.choice(["good", "partial"]) if corr != "incorrect" else "ignored",
                    "error_contributor": corr == "incorrect",
                    "correction": None if corr == "correct" else f"Should use different params for {call['name']}",
                    "annotated_by": ann["annotated_by"], "annotated_at": ann["annotated_at"],
                }
                act_id = f"{ev['id']}:{tc_r['testcase_id']}:{ai}"
                ALL_ACTION_ANNS.append((act_id, ev["id"], tc_r["testcase_id"], ai, act_ann))

    # ── Proposals ──
    ALL_PROPOSALS = []
    proposal_defs = [
        ("Procurement Agent", 2, "Add multi-tier risk mapping", "capability", 0.82, "high", "applied",
         "3 failed risk assessment tests", "+18% on risk-related test cases"),
        ("Procurement Agent", 3, "Improve MOQ negotiation strategy", "quality", 0.68, "medium", "pending",
         "Weak negotiation in small-batch scenarios", "+12% on negotiation tests"),
        ("Procurement Agent", 3, "Enhance contract red flag detection", "guardrails", 0.71, "medium", "pending",
         "Missed uncapped escalation clause in 2 contracts", "+15% on contract review tests"),
        ("Warehouse Manager", 2, "Cross-dock routing intelligence", "capability", 0.75, "high", "applied",
         "Failed to route perishables to outbound dock", "+22% on cross-dock scenarios"),
        ("Logistics Coordinator", 2, "Stricter SLA penalty enforcement", "guardrails", 0.55, "low", "dismissed",
         "Inconsistent penalty calculation", "More accurate penalty disputes"),
        ("Logistics Coordinator", 3, "Multi-modal route scoring", "quality", 0.63, "medium", "pending",
         "Defaulting to truck-only routes", "+10% cost savings on long-haul"),
        ("Quality Inspector", 2, "AQL sampling per ISO 2859-1", "capability", 0.78, "high", "applied",
         "Incorrect sample sizes for large lots", "Compliant sampling methodology"),
        ("Fleet Manager", 2, "Predictive maintenance thresholds", "guardrails", 0.70, "medium", "pending",
         "Missed service threshold on 2 vehicles", "Prevent mid-route breakdowns"),
        ("Customs & Trade Compliance", 2, "Preferential tariff rate application", "capability", 0.85, "high", "applied",
         "Missed TCA preferential rate on 4 shipments", "Annual duty savings"),
        ("Returns & Reverse Logistics", 2, "Batch-wide issue detection", "capability", 0.60, "medium", "pending",
         "Failed to flag pattern in return reasons", "Earlier quality interventions"),
        ("Computer Use Agent", 2, "Add page load verification", "guardrails", 0.73, "high", "applied",
         "3 failed tasks due to undetected navigation errors", "+20% on error recovery tests"),
        ("Computer Use Agent", 3, "Multi-page data compilation strategy", "quality", 0.65, "medium", "pending",
         "Incomplete data when visiting multiple pages", "+15% on multi-page navigation tests"),
    ]

    for (aname, pv, title, cat, conf, pri, status, src, impact) in proposal_defs:
        agent = next(a for a in AGENTS if a["name"] == aname)
        ALL_PROPOSALS.append({
            "id": _uid("proposal"), "agent_id": agent["id"], "prompt_version": pv,
            "title": title, "category": cat, "confidence": conf, "priority": pri,
            "pattern_source": src, "impact": impact, "impact_detail": "",
            "diff": {"removed": [], "added": [f"New rule: {title}"]},
            "status": status, "evidence": [],
            "reasoning": f"Analysis of failing supply chain test cases suggests: {title.lower()}.",
            "created_at": _ts(BASE_DATE + timedelta(days=random.randint(3, 12))),
        })

    # ── Write to DB ──
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    for sql in [
        "CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS testcases (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, data TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_tc_dataset ON testcases(dataset_id)",
        "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, agent_id TEXT, data TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_eval_agent ON evaluations(agent_id)",
        "CREATE TABLE IF NOT EXISTS run_annotations (id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(evaluation_id, run_id))",
        "CREATE TABLE IF NOT EXISTS action_annotations (id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL, run_id TEXT NOT NULL, action_index INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(evaluation_id, run_id, action_index))",
        "CREATE TABLE IF NOT EXISTS agent_prompts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(agent_id, version))",
        "CREATE INDEX IF NOT EXISTS idx_prompts_agent ON agent_prompts(agent_id)",
        "CREATE TABLE IF NOT EXISTS prompt_proposals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT DEFAULT 'pending', data TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_proposals_agent ON prompt_proposals(agent_id)",
        "CREATE INDEX IF NOT EXISTS idx_proposals_status ON prompt_proposals(status)",
        "CREATE TABLE IF NOT EXISTS judge_configs (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, version))",
        "CREATE TABLE IF NOT EXISTS cost_records (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_cost_eval ON cost_records(json_extract(data, '$.evaluation_id'))",
        
    ]:
        c.execute(sql)

    for a in AGENTS:
        c.execute("INSERT OR REPLACE INTO agents (id, data) VALUES (?, ?)", (a["id"], json.dumps(a)))
    for ds in ALL_DATASETS:
        c.execute("INSERT OR REPLACE INTO datasets (id, data) VALUES (?, ?)", (ds["id"], json.dumps(ds)))
    for tc in ALL_TESTCASES:
        c.execute("INSERT OR REPLACE INTO testcases (id, dataset_id, data) VALUES (?, ?, ?)",
                  (tc["id"], tc["dataset_id"], json.dumps(tc)))
    for p in ALL_PROMPTS:
        c.execute("INSERT OR REPLACE INTO agent_prompts (id, agent_id, version, data) VALUES (?, ?, ?, ?)",
                  (p["id"], p["agent_id"], p["version"], json.dumps(p)))
    for ev in ALL_EVALS:
        c.execute("INSERT OR REPLACE INTO evaluations (id, agent_id, data) VALUES (?, ?, ?)",
                  (ev["id"], ev["agent_id"], json.dumps(ev)))
    for ann_id, eid, rid, ann in ALL_RUN_ANNS:
        c.execute("INSERT OR REPLACE INTO run_annotations (id, evaluation_id, run_id, data) VALUES (?, ?, ?, ?)",
                  (ann_id, eid, rid, json.dumps(ann)))
    for ann_id, eid, rid, ai, ann in ALL_ACTION_ANNS:
        c.execute("INSERT OR REPLACE INTO action_annotations (id, evaluation_id, run_id, action_index, data) VALUES (?, ?, ?, ?, ?)",
                  (ann_id, eid, rid, ai, json.dumps(ann)))
    for pr in ALL_PROPOSALS:
        c.execute("INSERT OR REPLACE INTO prompt_proposals (id, agent_id, status, data) VALUES (?, ?, ?, ?)",
                  (pr["id"], pr["agent_id"], pr["status"], json.dumps(pr)))
    for jcfg in JUDGE_CONFIGS:
        c.execute("INSERT OR REPLACE INTO judge_configs (id, version, data) VALUES (?, ?, ?)",
                  (jcfg["id"], jcfg["version"], json.dumps(jcfg)))

    # ── Cost records (Analytics Hub Phase 1) ──
    ALL_COST_RECORDS = []
    for ev in ALL_EVALS:
        num_costs = random.randint(2, 4)
        for _ in range(num_costs):
            call_type = random.choice(["agent_invocation", "judge_llm"])
            tokens_in = random.randint(200, 2000)
            tokens_out = random.randint(50, 500)
            cost_usd = round(random.uniform(0.001, 0.05), 4)
            cost_record = {
                "id": _uid("cost"),
                "evaluation_id": ev["id"],
                "test_case_id": random.choice(ev["test_cases"])["testcase_id"] if ev["test_cases"] else None,
                "agent_id": ev["agent_id"],
                "call_type": call_type,
                "model": "qwen3-coder:latest",
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "cost_usd": cost_usd,
                "created_at": _ts(BASE_DATE + timedelta(days=random.randint(0, 14))),
            }
            ALL_COST_RECORDS.append(cost_record)

    for cr in ALL_COST_RECORDS:
        c.execute("INSERT OR REPLACE INTO cost_records (id, data) VALUES (?, ?)",
                  (cr["id"], json.dumps(cr)))


    conn.commit()
    conn.close()

    tc_total = sum(len(ev["test_cases"]) for ev in ALL_EVALS)
    tc_passed = sum(sum(1 for tc in ev["test_cases"] if tc["passed"]) for ev in ALL_EVALS)

    return {
        "agents": len(AGENTS),
        "datasets": len(ALL_DATASETS),
        "test_cases": len(ALL_TESTCASES),
        "prompts": len(ALL_PROMPTS),
        "judge_configs": len(JUDGE_CONFIGS),
        "evaluations": len(ALL_EVALS),
        "test_executions": tc_total,
        "test_passed": tc_passed,
        "pass_rate": round(tc_passed / tc_total * 100, 1) if tc_total > 0 else 0,
        "run_annotations": len(ALL_RUN_ANNS),
        "action_annotations": len(ALL_ACTION_ANNS),
        "proposals": len(ALL_PROPOSALS),
        "cost_records": len(ALL_COST_RECORDS),
    }
