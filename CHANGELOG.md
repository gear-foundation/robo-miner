# Changelog

## 0.1.1.0 - 2026-07-14

### Changed

- Open **Diggers** when needed to switch among live diggers; the roster stays collapsed by default and marks the selected digger on the map.

### Fixed

- Kept the map details bubble attached to the live digger after realtime snapshots refresh its position, so it does not drift after a state update.

## 0.1.0.0 - 2026-07-14

### Added

- A digger spectator roster for switching the camera between active diggers.
- Per-digger details including status, depth, cargo, banked resources, and a map info bubble.

### Changed

- A compact, touch-scrollable mobile spectator dock that leaves the mine visible.
- Stabilized spectator input to prevent roster flicker and missed taps.
