name: Fetch Stock Data

# When this workflow runs:
#   - 11am ET weekdays (15:00 UTC) — midday quote update
#   - 5pm ET weekdays (21:00 UTC) — after-close quote update + history refresh
#   - Manual via "Run workflow" button
#
# Note: cron times are UTC. Eastern Time DST shifts add 4-5 hours.
# These cron times account for ET ≈ UTC-4 (EDT, in effect most of the year).
on:
  schedule:
    - cron: '0 15 * * 1-5'   # ~11am ET — quote refresh only
    - cron: '0 21 * * 1-5'   # ~5pm ET — quote + history refresh
  workflow_dispatch:
    inputs:
      refresh_history:
        description: 'Also refresh price history (data/prices.csv)'
        type: boolean
        default: true

jobs:
  fetch:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install yfinance
        run: |
          python -m pip install --upgrade pip
          pip install 'yfinance>=0.2.50,<0.3'

      - name: Fetch quotes + fundamentals
        run: python fetch_data.py

      # Run history fetcher on every after-close run + every manual run.
      # The midday run skips it to keep cycle time short.
      - name: Fetch 5-year price history
        if: github.event_name == 'workflow_dispatch' || github.event.schedule == '0 21 * * 1-5'
        run: python fetch_history.py

      - name: Commit and push updated data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/master.csv data/master.json data/prices.csv data/prices.json
          if git diff --staged --quiet; then
            echo "No data changes to commit"
          else
            git commit -m "Update market data $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            git push
          fi
