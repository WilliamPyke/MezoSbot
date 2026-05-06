import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignMessage,
  useSwitchChain,
  useWalletClient,
  useWriteContract,
} from "wagmi";
import { formatUnits, isAddress, parseUnits } from "viem";
import { api, type AppConfig, type AssetConfig, type ChainConfig, type GameState, type SessionRow, type WalletSession } from "./api";
import { erc20Abi, escrowAbi } from "./abi";

type Route = { name: "home" } | { name: "session"; id: `0x${string}` };

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<31612 | 31611>(31612);
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null);
  const [route, setRoute] = useState<Route>(() => readRoute());
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    api<AppConfig>("/api/web/config")
      .then((res) => {
        setConfig(res);
        setSelectedChainId(res.defaultChainId);
      })
      .catch((err) => setStatus(err.message));
    api<{ session: WalletSession | null }>("/api/web/me")
      .then((res) => setWalletSession(res.session))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = next.name === "home" ? "/" : `/session/${next.id}`;
    window.history.pushState(null, "", path);
    setRoute(next);
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate({ name: "home" })}>
          <span className="mark">M</span>
          <span>Mallard Arcade</span>
        </button>
        <ConnectButton />
      </header>

      {status ? <div className="notice">{status}</div> : null}

      <section className="workspace">
        <aside className="side">
          <h1>Wallet-backed PvP on Mezo</h1>
          <p>
            Create a two-player session, escrow BTC, MUSD, or MEZO, play the same deterministic board,
            and settle winnings to the winner after the platform fee.
          </p>
          <NetworkPanel
            config={config}
            selectedChainId={selectedChainId}
            setSelectedChainId={setSelectedChainId}
            walletSession={walletSession}
            setWalletSession={setWalletSession}
          />
        </aside>

        {route.name === "home" ? (
          <CreateSession
            config={config}
            selectedChainId={selectedChainId}
            walletSession={walletSession}
            onCreated={(id) => navigate({ name: "session", id })}
            setStatus={setStatus}
          />
        ) : (
          <SessionView config={config} walletSession={walletSession} sessionId={route.id} setStatus={setStatus} />
        )}
      </section>
    </main>
  );
}

function NetworkPanel({
  config,
  selectedChainId,
  setSelectedChainId,
  walletSession,
  setWalletSession,
}: {
  config: AppConfig | null;
  selectedChainId: 31612 | 31611;
  setSelectedChainId: (chainId: 31612 | 31611) => void;
  walletSession: WalletSession | null;
  setWalletSession: (session: WalletSession | null) => void;
}) {
  const account = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const selectedChain = config?.chains.find((entry) => entry.chainId === selectedChainId) ?? null;

  async function signIn() {
    if (!account.address || !selectedChain) return;
    setBusy(true);
    try {
      if (chainId !== selectedChain.chainId) await switchChainAsync({ chainId: selectedChain.chainId });
      const nonce = await api<{ nonce: string; message: string }>("/api/web/auth/nonce", {
        method: "POST",
        body: JSON.stringify({ address: account.address, chainId: selectedChain.chainId }),
      });
      const signature = await signMessageAsync({ message: nonce.message });
      const verified = await api<{ session: WalletSession }>("/api/web/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address: account.address, chainId: selectedChain.chainId, nonce: nonce.nonce, signature }),
      });
      setWalletSession(verified.session);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api("/api/web/auth/logout", { method: "POST", body: "{}" });
    setWalletSession(null);
  }

  return (
    <div className="panel">
      <div className="row">
        <span>Network</span>
        <strong>{selectedChain ? selectedChain.chainName : "Loading"}</strong>
      </div>
      <div className="networkSwitch">
        {config?.chains.map((entry) => (
          <button
            key={entry.chainId}
            className={`chip ${entry.chainId === selectedChainId ? "active" : ""}`}
            onClick={() => setSelectedChainId(entry.chainId)}
          >
            {entry.network === "mainnet" ? "Mainnet" : "Testnet"}
          </button>
        ))}
      </div>
      <div className="row">
        <span>Escrow</span>
        <strong>{selectedChain?.escrowContractAddress ? short(selectedChain.escrowContractAddress) : "Not configured"}</strong>
      </div>
      <div className="row">
        <span>Signed in</span>
        <strong>{walletSession ? `${short(walletSession.address)} on ${walletSession.chainId}` : "No"}</strong>
      </div>
      {account.isConnected ? (
        walletSession ? (
          <button className="button secondary" onClick={logout}>Sign out</button>
        ) : (
          <button className="button primary" onClick={signIn} disabled={busy || !selectedChain}>
            {busy ? "Signing..." : "Sign in"}
          </button>
        )
      ) : (
        <p className="hint">Connect a wallet to create or join sessions.</p>
      )}
    </div>
  );
}

function CreateSession({
  config,
  selectedChainId,
  walletSession,
  onCreated,
  setStatus,
}: {
  config: AppConfig | null;
  selectedChainId: 31612 | 31611;
  walletSession: WalletSession | null;
  onCreated: (id: `0x${string}`) => void;
  setStatus: (status: string) => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [assetAddress, setAssetAddress] = useState<string>("");
  const [stake, setStake] = useState("0.001");
  const [invitedPlayer, setInvitedPlayer] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedChain = config?.chains.find((entry) => entry.chainId === selectedChainId) ?? null;

  useEffect(() => {
    if (selectedChain) setAssetAddress(selectedChain.assets[0].address);
  }, [selectedChainId, selectedChain]);

  const asset = selectedChain?.assets.find((entry) => entry.address.toLowerCase() === assetAddress.toLowerCase()) ?? null;
  const winnerPayout = useMemo(() => {
    if (!asset || !selectedChain) return "";
    const stakeUnits = safeParse(stake, asset.decimals);
    if (stakeUnits == null) return "";
    const pot = stakeUnits * 2n;
    const fee = (pot * BigInt(selectedChain.platformFeeBps)) / 10000n;
    return formatUnits(pot - fee, asset.decimals);
  }, [asset, selectedChain, stake]);

  async function create() {
    if (!selectedChain || !walletSession || !asset || !publicClient) return;
    if (walletSession.chainId !== selectedChain.chainId) throw new Error("Sign in on the selected network first");
    if (!selectedChain.escrowContractAddress) throw new Error("Escrow contract address is not configured");
    const stakeUnits = safeParse(stake, asset.decimals);
    if (stakeUnits == null || stakeUnits <= 0n) throw new Error("Enter a valid stake");
    if (invitedPlayer && !isAddress(invitedPlayer)) throw new Error("Invited wallet must be a valid address");

    setBusy(true);
    setStatus("");
    try {
      const draft = await api<{ session: SessionRow }>("/api/web/sessions", {
        method: "POST",
        body: JSON.stringify({
          assetAddress: asset.address,
          stakeAmountUnits: stakeUnits.toString(),
          invitedPlayer: invitedPlayer || null,
          chainId: selectedChain.chainId,
        }),
      });

      if (!asset.native) {
        setStatus("Approving token stake...");
        const approveHash = await writeContractAsync({
          address: asset.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [selectedChain.escrowContractAddress, stakeUnits],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setStatus("Creating escrow session...");
      const args = draft.session.contractArgs;
      const hash = await writeContractAsync({
        address: selectedChain.escrowContractAddress,
        abi: escrowAbi,
        functionName: "createSession",
        args: [
          args.sessionId,
          args.invitedPlayer,
          args.asset,
          BigInt(args.stakeAmount),
          BigInt(args.joinDeadline),
          BigInt(args.playDeadline),
        ],
        value: asset.native ? stakeUnits : undefined,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api(`/api/web/sessions/${draft.session.id}/created`, {
        method: "POST",
        body: JSON.stringify({ txHash: hash }),
      });
      setStatus("Session created.");
      onCreated(draft.session.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mainPanel">
      <h2>Create Session</h2>
      <label>
        Asset
        <select value={assetAddress} onChange={(event) => setAssetAddress(event.target.value)}>
          {selectedChain?.assets.map((entry) => (
            <option key={entry.symbol} value={entry.address}>{entry.label}</option>
          ))}
        </select>
      </label>
      <label>
        Stake per player
        <input value={stake} onChange={(event) => setStake(event.target.value)} inputMode="decimal" />
      </label>
      <label>
        Invite wallet
        <input value={invitedPlayer} onChange={(event) => setInvitedPlayer(event.target.value)} placeholder="Optional 0x..." />
      </label>
      <div className="summary">
        <span>Winner receives</span>
        <strong>{winnerPayout || "-"} {asset?.symbol.replace("_ERC20", "")}</strong>
      </div>
      <button className="button primary" disabled={!walletSession || !selectedChain || busy} onClick={() => create().catch((err) => setStatus(err.message))}>
        {busy ? "Creating..." : "Create and escrow"}
      </button>
    </section>
  );
}

function SessionView({
  config,
  walletSession,
  sessionId,
  setStatus,
}: {
  config: AppConfig | null;
  walletSession: WalletSession | null;
  sessionId: `0x${string}`;
  setStatus: (status: string) => void;
}) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionChain = session && config
    ? config.chains.find((entry) => entry.chainId === session.chain_id) ?? null
    : null;

  const load = useCallback(async () => {
    const payload = await api<{ session: SessionRow; game: GameState | null }>(`/api/web/sessions/${sessionId}`);
    setSession(payload.session);
    setGame(payload.game);
  }, [sessionId]);

  useEffect(() => {
    load().catch((err) => setStatus(err.message));
    const timer = window.setInterval(() => load().catch(() => {}), 4000);
    return () => window.clearInterval(timer);
  }, [load, setStatus]);

  async function copyInvite() {
    await navigator.clipboard.writeText(window.location.href);
    setStatus("Invite link copied.");
  }

  return (
    <section className="mainPanel">
      <div className="sessionHead">
        <div>
          <h2>Session {short(sessionId)}</h2>
          <p>{session ? `${session.asset_symbol} stake ${session.stake_amount_units}` : "Loading"}</p>
        </div>
        <button className="button secondary" onClick={copyInvite}>Copy invite</button>
      </div>

      {session && sessionChain && walletSession && session.status === "created" && walletSession.address !== session.player_a_address ? (
        <JoinSession chain={sessionChain} session={session} setBusy={setBusy} setStatus={setStatus} onJoined={load} />
      ) : null}

      {game?.self ? <GameBoard game={game} reload={load} setStatus={setStatus} /> : <WaitingPanel session={session} walletSession={walletSession} />}
      {busy ? <div className="notice">Waiting for wallet transaction...</div> : null}
    </section>
  );
}

function JoinSession({
  chain,
  session,
  setBusy,
  setStatus,
  onJoined,
}: {
  chain: ChainConfig;
  session: SessionRow;
  setBusy: (busy: boolean) => void;
  setStatus: (status: string) => void;
  onJoined: () => Promise<void>;
}) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const asset = chain.assets.find((entry) => entry.address.toLowerCase() === session.asset_address.toLowerCase());

  async function join() {
    if (!asset || !publicClient || !chain.escrowContractAddress) return;
    setBusy(true);
    setStatus("");
    try {
      if (chainId !== chain.chainId) await switchChainAsync({ chainId: chain.chainId });
      const stakeUnits = BigInt(session.stake_amount_units);
      if (!asset.native) {
        setStatus("Approving token stake...");
        const approveHash = await writeContractAsync({
          address: asset.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [chain.escrowContractAddress, stakeUnits],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
      setStatus("Joining escrow session...");
      const hash = await writeContractAsync({
        address: chain.escrowContractAddress,
        abi: escrowAbi,
        functionName: "joinSession",
        args: [session.id],
        value: asset.native ? stakeUnits : undefined,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await api(`/api/web/sessions/${session.id}/joined`, { method: "POST", body: JSON.stringify({ txHash: hash }) });
      await onJoined();
    } finally {
      setBusy(false);
    }
  }

  return <button className="button primary full" onClick={() => join().catch((err) => setStatus(err.message))}>Join and escrow stake</button>;
}

function WaitingPanel({ session, walletSession }: { session: SessionRow | null; walletSession: WalletSession | null }) {
  if (!walletSession) return <div className="empty">Sign in with your wallet to view or play this session.</div>;
  if (!session) return <div className="empty">Loading session...</div>;
  if (session.status === "created") return <div className="empty">Waiting for the second player to join.</div>;
  return <div className="empty">This wallet is not a player in the session.</div>;
}

function GameBoard({ game, reload, setStatus }: { game: GameState; reload: () => Promise<void>; setStatus: (status: string) => void }) {
  const [selected, setSelected] = useState(0);
  const [rotation, setRotation] = useState(0);
  const pieces = game.self?.pieces ?? [];
  const activePiece = pieces[selected];
  const cells = activePiece ? rotateCells(activePiece.cells, rotation) : [];
  const canPlay = game.self?.phase === "playing" && !game.self.submitted && !game.result.completed;

  async function place(row: number, col: number) {
    if (!canPlay || !activePiece || activePiece.placed) return;
    await api(`/api/web/sessions/${game.session.id}/move`, {
      method: "POST",
      body: JSON.stringify({ level: game.self!.level, pieceIndex: selected, rotation, row, col }),
    });
    setRotation(0);
    await reload();
  }

  async function submit() {
    await api(`/api/web/sessions/${game.session.id}/submit`, { method: "POST", body: "{}" });
    await reload();
  }

  return (
    <div className="game">
      <div className="hud">
        <Stat label="Score" value={game.self?.score.toLocaleString() ?? "0"} />
        <Stat label="Multiplier" value={`${game.self?.multiplier ?? 1}x`} />
        <Stat label="Level" value={`${game.self?.levelDisplay ?? 1}/${game.self?.maxLevels ?? 12}`} />
        <Stat label="Opponent" value={game.opponent?.submitted ? `Done ${game.opponent.score ?? 0}` : "Playing"} />
      </div>
      <div className="board">
        {game.self?.board.flatMap((row, r) =>
          row.map((value, c) => {
            const ghost = cells.some((cell) => r === cell.y && c === cell.x);
            return (
              <button
                key={`${r}-${c}`}
                className={`cell fill-${value} ${ghost ? "ghost" : ""}`}
                onClick={() => place(r, c).catch((err) => setStatus(err.message))}
              />
            );
          })
        )}
      </div>
      <div className="pieces">
        {pieces.map((piece, index) => (
          <button
            key={index}
            className={`piece ${selected === index ? "selected" : ""} ${piece.placed ? "placed" : ""}`}
            onClick={() => setSelected(index)}
            disabled={piece.placed}
          >
            Piece {index + 1}
          </button>
        ))}
      </div>
      <div className="actions">
        <button className="button secondary" disabled={!canPlay} onClick={() => setRotation((rotation + 1) % 4)}>Rotate</button>
        <button className="button primary" disabled={game.self?.submitted || game.result.completed} onClick={() => submit().catch((err) => setStatus(err.message))}>Submit score</button>
      </div>
      {game.result.completed ? (
        <div className="result">
          {game.result.isTie ? "Tie. Stakes refunded." : game.result.isWinner ? "You won." : "Opponent won."}
          {game.session.settlementTxHash ? <a href={`${game.session.explorerUrl}/tx/${game.session.settlementTxHash}`}>Settlement tx</a> : null}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong></div>;
}

function safeParse(value: string, decimals: number) {
  try {
    return parseUnits(value || "0", decimals);
  } catch {
    return null;
  }
}

function rotateCells<T extends { x: number; y: number; kind: string }>(input: T[], rotation: number): T[] {
  let out = input.map((cell) => ({ ...cell }));
  for (let i = 0; i < rotation; i += 1) {
    out = out.map((cell) => ({ ...cell, x: cell.y, y: -cell.x }));
  }
  const minX = Math.min(...out.map((cell) => cell.x), 0);
  const minY = Math.min(...out.map((cell) => cell.y), 0);
  return out.map((cell) => ({ ...cell, x: cell.x - minX, y: cell.y - minY }));
}

function readRoute(): Route {
  const match = window.location.pathname.match(/^\/session\/(0x[a-fA-F0-9]{64})$/);
  return match ? { name: "session", id: match[1].toLowerCase() as `0x${string}` } : { name: "home" };
}

function short(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
