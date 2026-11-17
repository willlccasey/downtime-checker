# Downtime Checker

Downtime checks whether public websites answer, then prints each result on one line.

## How it works

1. Open Downtime from the desktop icon, the application menu, or `python3 downtime.py`.
2. Pick a numbered search. `0` quits. On a submenu, `0` or `b` goes back.
3. For each place, the checker pings the website name. If ping stays silent, it tries TCP port 443, then port 80.
4. A place is UP when ping or either port answers. Otherwise it is DOWN.
5. Each result prints as soon as that place finishes: UP or DOWN, the name, the address, and the location.
6. Down places are listed again in a short block. The full results are then grouped by country, then by state. The country name is drawn large when `figlet` is installed. Blank lines separate countries.
7. The footer shows how many places were checked, how many are online, how many are offline, and which countries were in that search.

Catalog files store a sample IP next to each site. That IP is not what gets pinged. The checker uses the website name, because addresses change.

Location is where the address answers from, often a content network rather than the office. Lookups use ipwho.is and are saved in `locations.json` next to the program.

## Menu

1. Search everything
2. World governments
3. United States (opens a second menu limited to United States sites)
4. Banks and stock exchanges
5. Tech only (company sites and individual services such as Microsoft 365, Azure, Xbox, Google Drive, and AWS)
6. Utilities only
7. Education
8. Medical
9. Stock exchanges
10. Transportation
11. Stores
12. Communications (TV, phone, radio, cell, and internet)
13. Military (defense ministries and armed forces sites)
14. Shipping
15. Food
16. Weather
17. Choose a country (world government sites; United States opens the United States menu)
18. Add a place (a name plus an IP or web address, saved for later searches)

## Requirements

Python 3 and `ping`. Optional: `figlet` for large country names, and `qterminal` for the desktop launcher. Without `qterminal`, the launcher opens in the default terminal.

## Install

Python 3 must already be installed. The installer does not use the network and does not need root.

From a clone of this repository:

```bash
bash install.sh
```

That copies the program to `~/bin/downtime`, puts a Downtime icon on the Desktop, and adds it to the application menu. If a Pentesting folder is already on the Desktop, the launcher is placed there too.

An offline archive is `Downtime Checker.tar.gz`. The steps to install it from a terminal are in `INSTALL.txt`.

## Run without installing

```bash
python3 downtime.py
```

## Live visualizer (Node)

A globe dashboard that runs the same catalogs, ping + TCP 443/80 checks, and location cache as the Python CLI.

```bash
cd visualizer
node server.mjs
```

Open http://127.0.0.1:4173 — pick a mission, watch nodes light up as they answer.
