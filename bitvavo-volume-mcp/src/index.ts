import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const BITVAVO_API = "https://api.bitvavo.com/v2";

type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000
};

async function bitvavo(path: string): Promise<any> {
  const response = await fetch(`${BITVAVO_API}${path}`, {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Bitvavo HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function parseCandles(raw: any[]): Candle[] {
  return raw.map((c: any[]) => ({
    timestamp: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  })).sort((a, b) => a.timestamp - b.timestamp);
}

async function getClosedCandles(
  market: string,
  interval: string,
  count: number
): Promise<Candle[]> {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`Unsupported interval: ${interval}`);

  // Ask for extra candles because the newest one may still be open.
  const raw = await bitvavo(`/${encodeURIComponent(market)}/candles?interval=${encodeURIComponent(interval)}&limit=${Math.min(1440, count + 3)}`);
  const candles = parseCandles(raw);
  const now = Date.now();

  return candles.filter(c => c.timestamp + intervalMs <= now).slice(-count);
}

async function volumeAnomaly(
  market: string,
  interval: string,
  lookback: number,
  thresholdPct: number
) {
  const candles = await getClosedCandles(market, interval, lookback + 1);
  if (candles.length < lookback + 1) {
    throw new Error(`Not enough closed candles for ${market}: got ${candles.length}, need ${lookback + 1}`);
  }

  const latest = candles[candles.length - 1];
  const previous = candles.slice(candles.length - 1 - lookback, candles.length - 1);
  const average = previous.reduce((sum, c) => sum + c.volume, 0) / previous.length;
  const growthPct = average > 0 ? ((latest.volume / average) - 1) * 100 : null;
  const triggered = growthPct !== null && growthPct >= thresholdPct;

 const direction =
  latest.close > latest.open
    ? "bullish"
    : latest.close < latest.open
      ? "bearish"
      : "neutral";

return {
  market,
  interval,
  latestClosedCandleStart: new Date(latest.timestamp).toISOString(),
  latestClosedCandleEnd: new Date(latest.timestamp + INTERVAL_MS[interval]).toISOString(),
  latestOpen: latest.open,
  latestClose: latest.close,
  direction,
  latestVolume: latest.volume,
  averagePreviousVolumes: average,
  growthPct,
  thresholdPct,
  triggered
};
}

const server = new McpServer({
  name: "bitvavo-volume-mcp",
  version: "1.0.0"
});

server.registerTool(
  "check_volume_anomaly",
  {
    description:
      "Check one Bitvavo market for an anomalous volume increase. Uses the latest CLOSED candle and compares its volume with the average of the previous closed candles. Volume is the only alert criterion.",
    inputSchema: z.object({
      market: z.string().regex(/^[A-Z0-9]+-[A-Z0-9]+$/).describe("Bitvavo market, e.g. NPC-EUR"),
      interval: z.enum(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"]).default("5m"),
      lookback: z.number().int().min(2).max(200).default(20),
      thresholdPct: z.number().min(0).max(1000).default(10)
    })
  },
  async ({ market, interval, lookback, thresholdPct }) => {
    const result = await volumeAnomaly(market, interval, lookback, thresholdPct);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);

server.registerTool(
  "scan_volume_anomalies",
  {
    description:
      "Scan liquid Bitvavo EUR markets for anomalous CLOSED-candle volume. Liquidity is used only to choose the universe; the alert itself is based ONLY on the latest closed candle volume versus the average of the previous closed candles. Default: 5m, 20-candle average, +10%.",
    inputSchema: z.object({
      interval: z.enum(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"]).default("5m"),
      lookback: z.number().int().min(2).max(200).default(20),
      thresholdPct: z.number().min(0).max(1000).default(10),
      maxMarkets: z.number().int().min(5).max(80).default(40),
      minQuoteVolume24h: z.number().min(0).default(100000)
    })
  },
  async ({ interval, lookback, thresholdPct, maxMarkets, minQuoteVolume24h }) => {
    const [markets, tickers] = await Promise.all([
      bitvavo("/markets"),
      bitvavo("/ticker/24h")
    ]);

    const allowed = new Set(
      markets
        .filter((m: any) => m.status === "trading" && m.quote === "EUR")
        .map((m: any) => m.market)
    );

    const universe = tickers
      .filter((t: any) => allowed.has(t.market) && Number(t.volumeQuote) >= minQuoteVolume24h)
      .sort((a: any, b: any) => Number(b.volumeQuote) - Number(a.volumeQuote))
      .slice(0, maxMarkets);

    const results: any[] = [];
    const errors: any[] = [];

    // Keep concurrency moderate to avoid unnecessary rate-limit bursts.
    for (let i = 0; i < universe.length; i += 8) {
      const batch = universe.slice(i, i + 8);
      const batchResults = await Promise.all(batch.map(async (t: any) => {
        try {
          return await volumeAnomaly(t.market, interval, lookback, thresholdPct);
        } catch (error) {
          errors.push({ market: t.market, error: String(error) });
          return null;
        }
      }));
      results.push(...batchResults.filter(Boolean));
    }

    const anomalies = results
      .filter(r => r.triggered)
      .sort((a, b) => (b.growthPct ?? -Infinity) - (a.growthPct ?? -Infinity));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          criterion: `latest CLOSED ${interval} candle volume >= previous ${lookback}-candle average + ${thresholdPct}%`,
          universe: `EUR markets with 24h quote volume >= ${minQuoteVolume24h} EUR, capped at ${maxMarkets}`,
          checkedMarkets: universe.length,
          anomalies,
          errors
        }, null, 2)
      }]
    };
  }
);

const app = createMcpExpressApp({ host: "0.0.0.0" });

app.get("/", (_req, res) => {
  res.json({
    name: "bitvavo-volume-mcp",
    status: "ok",
    mcpEndpoint: "/mcp",
    purpose: "Read-only Bitvavo market-data MCP"
  });
});

app.post("/mcp", async (req, res) => {
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Bitvavo Volume MCP listening on port ${port}`);
});
