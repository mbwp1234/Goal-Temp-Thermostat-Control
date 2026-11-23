"""v2.9.1 — every coordinator attribute an entity or the API reads must exist.

v2.9.0 removed the ladder but switch.gttc_auto_season_switch still read
coordinator.heat_cool_ladder in its attributes, so HA refused the entity.
The unit tests never build entities, so this reads the sources instead.
"""
from __future__ import annotations

import glob
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "gttc"
BASE = {"hass", "data", "config_entry", "async_request_refresh", "async_set_updated_data",
        "last_update_success", "async_add_listener", "async_refresh",
        "async_config_entry_first_refresh"}


def test_every_coordinator_attribute_read_elsewhere_exists():
    src = (ROOT / "coordinator.py").read_text()
    defined = set(re.findall(r"self\.(_?[A-Za-z0-9_]+)\s*(?::[^=\n]*)?=", src))
    defined |= set(re.findall(r"def ([A-Za-z0-9_]+)\(", src))
    missing = []
    for f in glob.glob(str(ROOT / "*.py")):
        if f.endswith("coordinator.py"):
            continue
        for a in set(re.findall(r"coordinator\.([A-Za-z_][A-Za-z0-9_]*)", Path(f).read_text())):
            if a not in defined and a not in BASE:
                missing.append(f"{Path(f).name}: {a}")
    assert not missing, missing
