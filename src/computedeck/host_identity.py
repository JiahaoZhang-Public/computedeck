"""Host identity from collected addresses, never display names or DNS guesses."""

from ipaddress import IPv6Address, ip_address
from typing import Any


def host_address(value: Any) -> str | None:
    if not isinstance(value, str) or "%" in value:
        return None
    try:
        address = ip_address(value)
    except ValueError:
        return None
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    # Loopback/link-local addresses are not identities across hosts or networks.
    if (
        address.is_loopback
        or address.is_unspecified
        or address.is_link_local
        or address.is_multicast
    ):
        return None
    return str(address)


def ssh_endpoint(connection: Any) -> dict[str, Any] | None:
    """The server side of SSH_CONNECTION, read during the existing hardware probe."""
    fields = connection.split() if isinstance(connection, str) else []
    if len(fields) != 4 or not fields[3].isdigit():
        return None
    address, port = host_address(fields[2]), int(fields[3])
    return {"host": address, "port": port} if address and 0 < port <= 65535 else None


def short_hostname(value: Any) -> str | None:
    """A hostname corroborates an address; an IP written as a name does not."""
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip().rstrip(".").lower()
    try:
        ip_address(value)
    except ValueError:
        return value.split(".")[0] or None
    return None
