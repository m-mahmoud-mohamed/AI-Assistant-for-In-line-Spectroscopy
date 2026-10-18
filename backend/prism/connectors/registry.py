"""The one place the assistant harness asks for external tools. The connector layer decides which servers are
enabled and authorised, which of their tools the agent may see, and which calls need the scientist's approval."""
from __future__ import annotations

from prism.assist.tools import Tool


def agent_tools(session_id: str) -> list[Tool]:
    """Agent tools of the enabled, authorised connector servers for this session (none until one is configured)."""
    return []
