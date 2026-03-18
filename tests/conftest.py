"""Mock Home Assistant modules for testing GTTC outside of HA."""
import sys
from unittest.mock import MagicMock

# Create mock homeassistant module hierarchy before any GTTC imports
ha = MagicMock()
sys.modules["homeassistant"] = ha
sys.modules["homeassistant.components"] = ha.components
sys.modules["homeassistant.components.climate"] = ha.components.climate
sys.modules["homeassistant.components.frontend"] = ha.components.frontend
sys.modules["homeassistant.components.http"] = ha.components.http
sys.modules["homeassistant.components.select"] = ha.components.select
sys.modules["homeassistant.const"] = ha.const
sys.modules["homeassistant.core"] = ha.core
sys.modules["homeassistant.helpers"] = ha.helpers
sys.modules["homeassistant.helpers.storage"] = ha.helpers.storage
sys.modules["homeassistant.helpers.update_coordinator"] = ha.helpers.update_coordinator
sys.modules["homeassistant.helpers.entity_platform"] = ha.helpers.entity_platform
sys.modules["homeassistant.helpers.config_validation"] = ha.helpers.config_validation
sys.modules["homeassistant.config_entries"] = ha.config_entries

# Provide the classes/values that GTTC imports at module level
ha.components.climate.HVACAction = MagicMock()
ha.components.climate.HVACMode = MagicMock()
ha.components.climate.ClimateEntity = MagicMock
ha.components.climate.ClimateEntityFeature = MagicMock()
ha.const.ATTR_TEMPERATURE = "temperature"
ha.const.UnitOfTemperature = MagicMock()
ha.helpers.storage.Store = MagicMock
ha.helpers.update_coordinator.DataUpdateCoordinator = type(
    "DataUpdateCoordinator", (), {"__init__": lambda self, *a, **kw: None}
)
ha.helpers.update_coordinator.UpdateFailed = Exception
ha.helpers.config_validation.string = str
