import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * BTJ↔DKC DEX (Single Page)
 *
 * What this does:
 * - Connect wallet (Phantom/Solflare)
 * - Get a quote from Jupiter
 * - Build swap transaction via Jupiter
 * - Ask wallet to sign + send to Solana
 * - Show a clean dashboard + charts (DexScreener snapshot + a simple local chart)
 *
 * You MUST set these:
 * - BTJ_MINT
 * - DKC_MINT
 *
 * Optional but recommended:
 * - JUPITER_API_KEY (or paste into UI)
 *
 * References:
 * - Jupiter Quote: GET https://api.jup.ag/swap/v1/quote  (requires x-api-key)  
 * - Jupiter Swap:  POST https://api.jup.ag/swap/v1/swap   (requires x-api-key)
 */

// -------------------------
// CONFIG (EDIT THESE)
// -------------------------
const CONFIG = {
  APP_NAME: "DEX — BTJ ↔ DKC",
  RPC_ENDPOINT: "https://api.mainnet-beta.solana.com",

  // TODO: Replace with your real mints
  BTJ_MINT: "BTJ_MINT_HERE", // e.g. "..."
  DKC_MINT: "DKC_MINT_HERE", // e.g. "..."

  // Default UX settings
  DEFAULT_PRICE_TARGET: 10, // 1 BTJ = 10 DKC
  DEFAULT_SLIPPAGE_BPS: 100, // 1%

  // Jupiter v1 swap endpoints
  JUP_QUOTE_URL: "https://api.jup.ag/swap/v1/quote",
  JUP_SWAP_URL: "https://api.jup.ag/swap/v1/swap",

  // DexScreener snapshot endpoint (no key)
  DEXSCREENER_TOKEN_PAIRS_URL: "https://api.dexscreener.com/token-pairs/v1",
};

// Small helpers
const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
const fmt2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

function useLocalStorageState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, [key, value]);

  return [value, setValue] as const;
}

type DexScreenerPair = {
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string | null;
  priceNative?: string;
  liquidity?: { usd?: number } | null;
  volume?: { h24?: number } | null;
  txns?: { h24?: { buys?: number; sells?: number } } | null;
  priceChange?: { h24?: number } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
};

type JupiterQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  otherAmountThreshold: string;
  slippageBps: number;
  routePlan: any[];
};

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-lg backdrop-blur">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-white/90">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80">
      {children}
    </span>
  );
}

function GradientBg() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-white/10 blur-3xl" />
      <div className="absolute -bottom-48 left-10 h-[520px] w-[520px] rounded-full bg-white/10 blur-3xl" />
      <div className="absolute -bottom-56 right-10 h-[520px] w-[520px] rounded-full bg-white/10 blur-3xl" />
      <div className="absolute inset-0 bg-gradient-to-b from-black via-black to-black" />
    </div>
  );
}

function numberOrNull(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safePk(mint: string) {
  return new PublicKey(mint);
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${t ? ` — ${t}` : ""}`);
  }
  return res.json();
}

function useDexScreenerSnapshot(tokenMint: string) {
  const [pairs, setPairs] = useState<DexScreenerPair[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!tokenMint || tokenMint.includes("_HERE")) return;
      try {
        setLoading(true);
        setError(null);
        const url = `${CONFIG.DEXSCREENER_TOKEN_PAIRS_URL}/solana/${tokenMint}`;
        const data = await fetchJson(url);
        if (!mounted) return;
        setPairs(Array.isArray(data) ? data : data?.pairs ?? null);
      } catch (e: any) {
        if (!mounted) return;
        setError(e?.message ?? String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [tokenMint]);

  const best = useMemo(() => {
    if (!pairs?.length) return null;
    // pick the pair with highest liquidity USD
    return [...pairs].sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
  }, [pairs]);

  return { pairs, best, loading, error };
}

function SwapPanel() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction, connected } = useWallet();

  const [apiKey, setApiKey] = useLocalStorageState<string>("btj_dex_jup_api_key", "");
  const [slippageBps, setSlippageBps] = useLocalStorageState<number>("btj_dex_slippage_bps", CONFIG.DEFAULT_SLIPPAGE_BPS);

  const [side, setSide] = useState<"BTJ_TO_DKC" | "DKC_TO_BTJ">("BTJ_TO_DKC");
  const inputMint = side === "BTJ_TO_DKC" ? CONFIG.BTJ_MINT : CONFIG.DKC_MINT;
  const outputMint = side === "BTJ_TO_DKC" ? CONFIG.DKC_MINT : CONFIG.BTJ_MINT;

  // Human amount (we’ll treat as decimals unknown; user can edit raw if needed)
  const [humanAmount, setHumanAmount] = useState<string>("1");
  const [decimalsIn, setDecimalsIn] = useLocalStorageState<number>("btj_dex_decimals_in", 6);
  const [decimalsOut, setDecimalsOut] = useLocalStorageState<number>("btj_dex_decimals_out", 6);

  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [swapping, setSwapping] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  const inAmountRaw = useMemo(() => {
    const n = Number(humanAmount);
    if (!Number.isFinite(n) || n <= 0) return "0";
    // raw amount integer
    const raw = Math.round(n * Math.pow(10, decimalsIn));
    return String(raw);
  }, [humanAmount, decimalsIn]);

  const outHuman = useMemo(() => {
    if (!quote) return null;
    const raw = Number(quote.outAmount);
    if (!Number.isFinite(raw)) return null;
    return raw / Math.pow(10, decimalsOut);
  }, [quote, decimalsOut]);

  const canQuote = useMemo(() => {
    try {
      if (!inputMint || !outputMint) return false;
      if (inputMint.includes("_HERE") || outputMint.includes("_HERE")) return false;
      safePk(inputMint);
      safePk(outputMint);
      return Number(inAmountRaw) > 0;
    } catch {
      return false;
    }
  }, [inputMint, outputMint, inAmountRaw]);

  async function getQuote() {
    if (!canQuote) return;
    setQuoting(true);
    setQuote(null);
    setQuoteError(null);
    setSig(null);
    try {
      const u = new URL(CONFIG.JUP_QUOTE_URL);
      u.searchParams.set("inputMint", inputMint);
      u.searchParams.set("outputMint", outputMint);
      u.searchParams.set("amount", inAmountRaw);
      u.searchParams.set("slippageBps", String(slippageBps));
      u.searchParams.set("swapMode", "ExactIn");

      const data = (await fetchJson(u.toString(), {
        headers: apiKey ? { "x-api-key": apiKey } : undefined,
      })) as JupiterQuote;

      setQuote(data);
    } catch (e: any) {
      setQuoteError(e?.message ?? String(e));
    } finally {
      setQuoting(false);
    }
  }

  async function doSwap() {
    if (!connected || !publicKey) {
      setSwapError("Connect wallet first.");
      return;
    }
    if (!quote) {
      setSwapError("Get a quote first.");
      return;
    }
    if (!apiKey) {
      setSwapError("Jupiter API key is required (paste it in the field).");
      return;
    }

    setSwapping(true);
    setSwapError(null);
    setSig(null);

    try {
      const body = {
        userPublicKey: publicKey.toBase58(),
        quoteResponse: quote,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        // Very fast confirmations (optional)
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            priorityLevel: "veryHigh",
            maxLamports: 1_000_000,
          },
        },
      };

      const data = await fetchJson(CONFIG.JUP_SWAP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });

      const swapTxB64 = data?.swapTransaction as string | undefined;
      if (!swapTxB64) throw new Error("Swap API returned no swapTransaction.");

      const txBuf = Uint8Array.from(atob(swapTxB64), (c) => c.charCodeAt(0));

      // Jupiter returns versioned tx by default
      let signedSig: string;
      try {
        const vtx = VersionedTransaction.deserialize(txBuf);
        const signed = await signTransaction!(vtx as any);
        signedSig = await connection.sendTransaction(signed, {
          skipPreflight: false,
          maxRetries: 3,
        });
      } catch {
        // Fallback for legacy tx if needed
        const legacy = Transaction.from(txBuf);
        const signed = await signTransaction!(legacy as any);
        signedSig = await sendTransaction(signed as any, connection);
      }

      setSig(signedSig);

      // confirm
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction(
        {
          signature: signedSig,
          ...latest,
        },
        "confirmed"
      );
    } catch (e: any) {
      setSwapError(e?.message ?? String(e));
    } finally {
      setSwapping(false);
    }
  }

  // Auto-quote with debounce
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!canQuote) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      getQuote();
    }, 550);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, humanAmount, decimalsIn, decimalsOut, slippageBps, inputMint, outputMint]);

  const impliedPrice = useMemo(() => {
    if (!quote) return null;
    const inH = Number(quote.inAmount) / Math.pow(10, decimalsIn);
    const outH = Number(quote.outAmount) / Math.pow(10, decimalsOut);
    if (!Number.isFinite(inH) || !Number.isFinite(outH) || inH <= 0) return null;
    // price in output per 1 input
    return outH / inH;
  }, [quote, decimalsIn, decimalsOut]);

  const target = side === "BTJ_TO_DKC" ? CONFIG.DEFAULT_PRICE_TARGET : 1 / CONFIG.DEFAULT_PRICE_TARGET;

  return (
    <Card
      title="Swap"
      right={
        <div className="flex items-center gap-2">
          <Pill>Solana</Pill>
          <Pill>{side === "BTJ_TO_DKC" ? "BTJ → DKC" : "DKC → BTJ"}</Pill>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3">
        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-white/60">Route</div>
            <div className="flex items-center gap-2">
              <button
                className={cn(
                  "rounded-lg px-3 py-2 text-sm",
                  side === "BTJ_TO_DKC" ? "bg-white text-black" : "bg-white/10 text-white"
                )}
                onClick={() => setSide("BTJ_TO_DKC")}
              >
                BTJ → DKC
              </button>
              <button
                className={cn(
                  "rounded-lg px-3 py-2 text-sm",
                  side === "DKC_TO_BTJ" ? "bg-white text-black" : "bg-white/10 text-white"
                )}
                onClick={() => setSide("DKC_TO_BTJ")}
              >
                DKC → BTJ
              </button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-white/60">You pay</div>
              <div className="flex items-center gap-2">
                <input
                  value={humanAmount}
                  onChange={(e) => setHumanAmount(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-lg text-white outline-none"
                  inputMode="decimal"
                  placeholder="0.0"
                />
                <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-white/90">
                  {side === "BTJ_TO_DKC" ? "BTJ" : "DKC"}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-white/60">Decimals (in):</span>
                <input
                  value={String(decimalsIn)}
                  onChange={(e) => setDecimalsIn(Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
                  className="w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none"
                />
                <span className="text-xs text-white/60">Slippage (bps):</span>
                <input
                  value={String(slippageBps)}
                  onChange={(e) => setSlippageBps(Math.max(0, Math.min(5000, Number(e.target.value) || 0)))}
                  className="w-24 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none"
                />
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs text-white/60">You receive (est.)</div>
              <div className="flex items-center gap-2">
                <div className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-lg text-white">
                  {quoting ? "…" : outHuman === null ? "—" : fmt.format(outHuman)}
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-white/90">
                  {side === "BTJ_TO_DKC" ? "DKC" : "BTJ"}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-white/60">Decimals (out):</span>
                <input
                  value={String(decimalsOut)}
                  onChange={(e) => setDecimalsOut(Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
                  className="w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none"
                />
                <Pill>
                  Target: 1 {side === "BTJ_TO_DKC" ? "BTJ" : "DKC"} ≈ {fmt.format(target)} {side === "BTJ_TO_DKC" ? "DKC" : "BTJ"}
                </Pill>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="text-xs text-white/60">Implied price (from quote)</div>
              <div className="mt-1 text-xl font-semibold text-white">
                {impliedPrice === null ? "—" : `1 ${side === "BTJ_TO_DKC" ? "BTJ" : "DKC"} ≈ ${fmt.format(impliedPrice)} ${side === "BTJ_TO_DKC" ? "DKC" : "BTJ"}`}
              </div>
              <div className="mt-1 text-xs text-white/60">
                Price impact: {quote ? `${fmt2.format(Number(quote.priceImpactPct) * 100)}%` : "—"}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="text-xs text-white/60">Jupiter API key</div>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none"
                placeholder="paste x-api-key here (portal.jup.ag)"
              />
              <div className="mt-2 text-xs text-white/60">Saved in your browser (localStorage).</div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              className={cn(
                "rounded-xl px-4 py-3 text-sm font-semibold",
                canQuote ? "bg-white text-black" : "bg-white/10 text-white/50"
              )}
              onClick={getQuote}
              disabled={!canQuote || quoting}
            >
              {quoting ? "Quoting…" : "Refresh quote"}
            </button>

            <button
              className={cn(
                "rounded-xl px-4 py-3 text-sm font-semibold",
                connected && quote ? "bg-white text-black" : "bg-white/10 text-white/50"
              )}
              onClick={doSwap}
              disabled={!connected || !quote || swapping}
            >
              {swapping ? "Swapping…" : "Swap"}
            </button>

            {sig && (
              <a
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/90 hover:bg-white/10"
                href={`https://solscan.io/tx/${sig}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Solscan
              </a>
            )}
          </div>

          {(quoteError || swapError) && (
            <div className="mt-3 rounded-xl border border-white/10 bg-black/40 p-3 text-sm text-white/80">
              <div className="font-semibold">Error</div>
              <div className="mt-1 whitespace-pre-wrap text-xs text-white/70">{quoteError || swapError}</div>
            </div>
          )}

          {!apiKey && (
            <div className="mt-3 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/70">
              Jupiter v1 endpoints require <span className="text-white">x-api-key</span>.
              Create it in the Jupiter portal, then paste it here.
            </div>
          )}

          {(CONFIG.BTJ_MINT.includes("_HERE") || CONFIG.DKC_MINT.includes("_HERE")) && (
            <div className="mt-3 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/70">
              ⚠️ Set <span className="text-white">BTJ_MINT</span> and <span className="text-white">DKC_MINT</span> at the top of this file.
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function MarketPanel() {
  const { best: btjBest, loading: btjLoading, error: btjError } = useDexScreenerSnapshot(CONFIG.BTJ_MINT);

  const [chartData, setChartData] = useState<Array<{ t: string; v: number }>>([]);

  // Build a simple “pretty” local chart from snapshot numbers (not candles)
  useEffect(() => {
    const now = Date.now();
    const base = numberOrNull(btjBest?.priceUsd) ?? 0;
    if (!base) {
      setChartData([]);
      return;
    }

    // synthetic 24 points (purely UI). Replace later with real candles if you want.
    const points: Array<{ t: string; v: number }> = [];
    let v = base;
    for (let i = 23; i >= 0; i--) {
      const ts = new Date(now - i * 60 * 60 * 1000);
      // small deterministic wobble
      const wobble = Math.sin((23 - i) / 3) * (base * 0.01);
      v = Math.max(0, base + wobble);
      points.push({
        t: `${ts.getHours().toString().padStart(2, "0")}:00`,
        v,
      });
    }
    setChartData(points);
  }, [btjBest?.priceUsd]);

  const p = btjBest;
  const priceUsd = numberOrNull(p?.priceUsd);
  const liqUsd = p?.liquidity?.usd ?? null;
  const vol24 = p?.volume?.h24 ?? null;
  const buys = p?.txns?.h24?.buys ?? null;
  const sells = p?.txns?.h24?.sells ?? null;
  const ch24 = p?.priceChange?.h24 ?? null;

  return (
    <Card
      title="Market"
      right={
        <div className="flex items-center gap-2">
          <Pill>{p?.dexId ? `DEX: ${p.dexId}` : "DEX"}</Pill>
          {p?.url ? (
            <a
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
              href={p.url}
              target="_blank"
              rel="noreferrer"
            >
              Open pair
            </a>
          ) : null}
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="text-xs text-white/60">BTJ Price (USD)</div>
            <div className="mt-1 text-xl font-semibold text-white">{priceUsd ? `$${fmt.format(priceUsd)}` : "—"}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="text-xs text-white/60">Liquidity</div>
            <div className="mt-1 text-xl font-semibold text-white">{liqUsd ? `$${fmt2.format(liqUsd)}` : "—"}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="text-xs text-white/60">Volume (24h)</div>
            <div className="mt-1 text-xl font-semibold text-white">{vol24 ? `$${fmt2.format(vol24)}` : "—"}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="text-xs text-white/60">Change (24h)</div>
            <div className={cn("mt-1 text-xl font-semibold", ch24 === null ? "text-white" : ch24 >= 0 ? "text-white" : "text-white")}>
              {ch24 === null ? "—" : `${fmt2.format(ch24)}%`}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-white/60">BTJ (UI chart)</div>
            <div className="flex items-center gap-2">
              <Pill>{buys !== null && sells !== null ? `24h tx: ${buys} buys / ${sells} sells` : "24h tx"}</Pill>
              <Pill>Source: DexScreener</Pill>
            </div>
          </div>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="t" tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickLine={false} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 12 }} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "rgba(0,0,0,0.8)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, color: "white" }}
                  labelStyle={{ color: "rgba(255,255,255,0.8)" }}
                />
                <Area type="monotone" dataKey="v" stroke="rgba(255,255,255,0.8)" fill="rgba(255,255,255,0.08)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 text-xs text-white/60">
            Note: chart is a UI placeholder. For real candles, plug in your preferred data source and replace <code className="rounded bg-white/5 px-1">chartData</code>.
          </div>
        </div>

        {(btjLoading || btjError) && (
          <div className="rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/70">
            {btjLoading ? "Loading snapshot…" : `DexScreener error: ${btjError}`}
          </div>
        )}
      </div>
    </Card>
  );
}

function WalletAndHeader() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();

  const [sol, setSol] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!publicKey) {
        setSol(null);
        return;
      }
      const bal = await connection.getBalance(publicKey);
      if (!mounted) return;
      setSol(bal / LAMPORTS_PER_SOL);
    })();
    return () => {
      mounted = false;
    };
  }, [connection, publicKey]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-2xl font-bold text-white">{CONFIG.APP_NAME}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/70">
          <Pill>BTJ</Pill>
          <Pill>DKC</Pill>
          <Pill>Fast swap via Jupiter</Pill>
          {publicKey ? <Pill>SOL: {sol === null ? "…" : fmt.format(sol)}</Pill> : <Pill>Wallet disconnected</Pill>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <WalletMultiButton className="!rounded-xl !bg-white !text-black hover:!bg-white/90" />
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div className="mt-10 text-center text-xs text-white/50">
      <div className="mx-auto max-w-3xl">
        Risk notice: swapping low-liquidity tokens can cause high slippage. Always verify mint addresses.
      </div>
    </div>
  );
}

function Dapp() {
  return (
    <div className="min-h-screen bg-black text-white">
      <GradientBg />
      <div className="mx-auto max-w-6xl px-4 py-8">
        <WalletAndHeader />

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <SwapPanel />
          </div>
          <div className="lg:col-span-3">
            <MarketPanel />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="How to launch">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-white/80">
              <li>Replace <code className="rounded bg-white/5 px-1">BTJ_MINT</code> and <code className="rounded bg-white/5 px-1">DKC_MINT</code> in this file.</li>
              <li>Install deps (see below).</li>
              <li>Run dev server, open the page, connect wallet.</li>
              <li>Create a Jupiter API key and paste into the UI.</li>
            </ol>
          </Card>

          <Card title="Recommended deps">
            <pre className="overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/70">
{`npm i @solana/web3.js \
  @solana/wallet-adapter-react \
  @solana/wallet-adapter-react-ui \
  @solana/wallet-adapter-wallets \
  recharts

# Tailwind (recommended) – or keep your own CSS
npm i -D tailwindcss postcss autoprefixer`}
            </pre>
            <div className="mt-2 text-xs text-white/60">
              Also import wallet-adapter styles once:
              <code className="ml-2 rounded bg-white/5 px-1">import '@solana/wallet-adapter-react-ui/styles.css'</code>
            </div>
          </Card>

          <Card title="Upgrade ideas">
            <ul className="list-disc space-y-2 pl-5 text-sm text-white/80">
              <li>Add real candles (DexCheck / Birdeye / Helius / your indexer).</li>
              <li>Show route plan labels from Jupiter (DEX hops).</li>
              <li>Add "Max" button (fetch token balance via SPL Token).</li>
              <li>Add a dedicated BTJ/DKC pool page + LP links.</li>
            </ul>
          </Card>
        </div>

        <Footer />
      </div>
    </div>
  );
}

export default function App() {
  const endpoint = CONFIG.RPC_ENDPOINT;
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Dapp />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
