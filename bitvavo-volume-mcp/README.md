# Bitvavo Volume MCP

Read-only remote MCP server for Bitvavo public market data.

## Tool

`scan_volume_anomalies`

Default detector:
- Bitvavo EUR markets
- latest CLOSED 5-minute candle
- compare with average volume of previous 20 CLOSED 5-minute candles
- alert at >= +10%
- no price/news/breakout criterion

Liquidity is used only to define the scan universe.

## Deployment

Railway:
1. Connect this repository to the Railway service.
2. Railway builds with `npm run build`.
3. Start command: `npm start`.
4. Generate a public HTTPS domain.
5. MCP endpoint: `https://YOUR-DOMAIN/mcp`

No Bitvavo API key is required because the market-data endpoints used here are public.
