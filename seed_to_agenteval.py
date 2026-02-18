#!/usr/bin/env python3
import sys
sys.path.insert(0, '.')
import seed_demo_clean

# Override DB path
seed_demo_clean.DB_PATH = "agenteval.db"

if __name__ == "__main__":
    seed_demo_clean.insert_all()
    
    tc_total = sum(len(ev["test_cases"]) for ev in seed_demo_clean.ALL_EVALS)
    tc_passed = sum(sum(1 for tc in ev["test_cases"] if tc["passed"]) for ev in seed_demo_clean.ALL_EVALS)
    
    print(f"\n  ✓ {len(seed_demo_clean.AGENTS)} agents")
    print(f"  ✓ {len(seed_demo_clean.ALL_DATASETS)} datasets ({len(seed_demo_clean.ALL_TESTCASES)} test cases)")
    print(f"  ✓ {len(seed_demo_clean.ALL_EVALS)} evaluation runs")
    print(f"  ✓ {tc_total} test executions ({tc_passed} passed)")
    print(f"\n  DB: agenteval.db")
    print(f"  ✅ Ready!\n")
