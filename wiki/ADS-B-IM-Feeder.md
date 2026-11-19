# ADS-B IM feeder

**Status:** documented, not built. There is no feeder machine on the bench yet. Keep this page so the globe can grow a local 1090 MHz feed later.

Official guide: [https://adsb.im/howto](https://adsb.im/howto)  
Images and board list: [https://adsb.im/download](https://adsb.im/download) · [https://adsb.im/supported](https://adsb.im/supported)  
Videos: [youtube.com/@adsb](https://youtube.com/@adsb) · setup walkthrough [youtu.be/N5yHvInpDBM](https://youtu.be/N5yHvInpDBM)

[ADSB.im](https://adsb.im) is a ready-made OS image for a small computer plus an SDR dongle. It turns that box into an ADS-B receiver, a local map, and a feeder to public aggregators. It is the path to a globe.adsbexchange-style picture that we own, without scraping ADS-B Exchange.

Until that hardware exists, the Cesium **AIR** overlay uses the public [adsb.lol](https://adsb.lol) v2 API (ODbL): military, LADD, PIA, squawk 7700, and 250 nm circles around the Jonesboro hub plus rotating terminals. That is the same readsb aircraft record the globe.adsb.lol map uses (callsign, hex, type, registration, squawk, emergency, altitude, track, flags). Unkeyed quota is 500 requests/day, so the visualizer polls every 3 minutes and keeps a 15-minute cache. Set `ADSB_LOL_API_KEY` to raise the cap. OpenSky is the fallback if adsb.lol errors and the cache is empty.

## Why this belongs on the app

| Now | Later, with an ADSB.im box |
| --- | --- |
| AIR layer from adsb.lol public v2 / OpenSky | AIR layer from the local feeder (`tar1090` / `readsb`, usually `http://adsb-feeder.local`) merged on top |
| Coverage is wherever aggregators already have receivers | Extra coverage around our antenna, plus we contribute back |
| No extra hardware | Pi-class SBC, 1090 MHz SDR, antenna |

Do not treat globe.adsbexchange.com as an API. ADSB.im is how you *feed* those networks instead of cloning their UI.

## Hardware (from the official howto)

Minimum kit:

- SBC from the [supported boards](https://adsb.im/supported) list. Cheap: Orange Pi Zero 3 (1 GB). Comfortable: Raspberry Pi 4 (1 GB is enough).
- Real power supply, not a phone charger. USB-C boards want ~2.5 A; Pi 4 wants ~4 A. Bad power is the usual random-reboot cause.
- Quality microSD, 8 GB minimum, 64 GB is the current sweet spot (January 2026 pricing). SanDisk Ultra or Samsung High Endurance.
- Network: Ethernet, or Wi-Fi on Pi-family boards. First-boot Wi-Fi is the [hotspot flow](https://adsb.im/hotspot).
- SDR USB dongle from the [supported SDRs](https://adsb.im/supported) list.
- 1090 MHz antenna. Indoor rubber-duck works; outdoor vertical (FlightAware / RadarBox / DPD / Vinnant) is the upgrade.

Ballpark: about $80 with Orange Pi + imported SDR, or about $120 with a Pi 4 indoor kit. Cooling matters. Larger SD cards last longer because of how Linux writes; first boot is slower on a big card.

Example the upstream guide walks through: Libre Computer Le Potato, CanaKit micro-USB PSU, SanDisk Ultra 32 GB, generic SDR, generic 1090 MHz duck.

## Setup (condensed from adsb.im/howto)

Do this on a PC or Mac. The feeder image has no desktop.

1. [Download](https://adsb.im/download) the image for the board. Raspberry Pi can also pick it inside Raspberry Pi Imager under **Other specific-purpose OS**.
2. Write it with [Raspberry Pi Imager](https://www.raspberrypi.com/software). For non-Pi boards: **Choose OS → Use custom** and pick the `adsb-feeder….img.xz`. **Choose Storage** on the SD card. Double-check the volume. Write and verify. Eject.
3. SD card into the SBC (usually label down). Antenna on the SDR, SDR in USB, then power. Wait out first boot. Bigger cards take longer.
4. From another computer open [http://adsb-feeder.local](http://adsb-feeder.local). Fallback: [http://my.adsb.im/](http://my.adsb.im/) or the DHCP lease on the router.
5. In the web UI: name (used on MLAT graphs), antenna lat/lon/elevation, timezone, enable ADS-B feed, **Setup**, then pick aggregators.

Wi-Fi-only boards: follow [adsb.im/hotspot](https://adsb.im/hotspot) before step 4.

## Hook into Downtime later

When a feeder is on the LAN:

1. Confirm the local map loads (tar1090 on the feeder).
2. Set `ADS_B_FEEDER_URL=http://adsb-feeder.local` so AIR merges the local `data/aircraft.json` with the adsb.lol cache.
3. Keep GPS jam, CFR, AIS, Uniden radio, and Broadcastify streams as they are. The feeder only replaces or supplements **AIR**.

Env sketch (not wired yet):

```bash
ADS_B_FEEDER_URL=http://adsb-feeder.local
# optional, raises the public API cap
ADSB_LOL_API_KEY=
```

## Source

This page is a Downtime-facing summary of [adsb.im/howto](https://adsb.im/howto) by the ADSB.im / [adsb-feeder-image](https://github.com/dirkhh/adsb-feeder-image) project. Buy lists, board images, and troubleshooting live there. Update this page if the feeder is actually installed.
