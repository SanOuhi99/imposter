import { randomInt, randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { CATEGORY_NAMES, GAME_CATEGORIES } from "./gameCatalog";

export type GamePhase = "lobby" | "reveal" | "discussion" | "vote" | "tie" | "results";

export interface RoomSettings {
  impostorCount: number;
  allCategories: boolean;
  selectedCategories: string[];
  timerEnabled: boolean;
  showImpostorClue: boolean;
}

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  isHost: boolean;
}

export interface PublicRoomView {
  code: string;
  phase: GamePhase;
  hostId: string;
  firstSpeakerId: string | null;
  players: PlayerView[];
  settings: RoomSettings;
  categoryOptions: string[];
  readyCount: number;
  pendingRolePlayerIds: string[];
  pendingVotePlayerIds: string[];
  voteCount: number;
  timerEndsAt: number | null;
  timerRemainingMs: number;
  runoffCount: number;
  tiedPlayerIds: string[];
  candidateIds: string[] | null;
  resolvedSuspectId: string | null;
  category: string | null;
  word: string | null;
  impostorIds: string[] | null;
  winner: "group" | "impostors" | null;
  voteHistory: Array<{ label: string; ballots: Array<{ voterId: string; targetId: string }> }> | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
}

export interface PrivatePlayerState {
  role: "impostor" | "crew" | null;
  word: string | null;
  category: string | null;
  roleSeen: boolean;
  hasVoted: boolean;
}

export interface RoomAck {
  ok: boolean;
  error?: string;
  code?: string;
  playerId?: string;
}

export interface CreateRoomInput extends RoomSettings {
  name: string;
}

export interface JoinRoomInput {
  code: string;
  name: string;
}

export interface ResumeRoomInput {
  code: string;
  playerId: string;
}

export interface UpdateRoomSettingsInput extends RoomSettings {}

interface ClientToServerEvents {
  "room:create": (payload: CreateRoomInput, ack: (response: RoomAck) => void) => void;
  "room:join": (payload: JoinRoomInput, ack: (response: RoomAck) => void) => void;
  "room:resume": (payload: ResumeRoomInput, ack: (response: RoomAck) => void) => void;
  "room:update-settings": (payload: UpdateRoomSettingsInput, ack: (response: RoomAck) => void) => void;
  "room:chat": (payload: { text: string }, ack: (response: RoomAck) => void) => void;
  "room:leave": (ack: (response: RoomAck) => void) => void;
  "game:start": (ack: (response: RoomAck) => void) => void;
  "game:role-seen": (ack: (response: RoomAck) => void) => void;
  "game:discussion": (payload: { action: "start" | "pause" | "resume" | "skip" }, ack: (response: RoomAck) => void) => void;
  "game:vote": (payload: { targetId: string }, ack: (response: RoomAck) => void) => void;
  "game:start-runoff": (ack: (response: RoomAck) => void) => void;
  "game:play-again": (ack: (response: RoomAck) => void) => void;
}

interface ServerToClientEvents {
  "room:state": (state: PublicRoomView) => void;
  "player:private": (state: PrivatePlayerState | null) => void;
  "room:chat-history": (messages: ChatMessage[]) => void;
  "room:chat-message": (message: ChatMessage) => void;
}

interface SocketData {
  roomCode?: string;
  playerId?: string;
}

interface Player {
  id: string;
  name: string;
  socketId: string | null;
  connected: boolean;
  lastChatAt: number;
}

interface Ballot {
  voterId: string;
  targetId: string;
}

interface Room {
  code: string;
  hostId: string;
  players: Player[];
  sockets: Map<string, GameSocket>;
  settings: RoomSettings;
  firstSpeakerId: string | null;
  chatMessages: ChatMessage[];
  phase: GamePhase;
  word: string | null;
  category: string | null;
  impostorIds: Set<string>;
  previousImpostorIds: Set<string>;
  previousCategory: string | null;
  usedWordsByCategory: Map<string, Set<string>>;
  lastWordByCategory: Map<string, string>;
  previousFirstSpeakerId: string | null;
  roleAckIds: Set<string>;
  votes: Map<string, string>;
  voteHistory: Array<{ label: string; ballots: Ballot[] }>;
  candidateIds: string[] | null;
  tiedPlayerIds: string[];
  resolvedSuspectId: string | null;
  winner: "group" | "impostors" | null;
  runoffCount: number;
  timerEndsAt: number | null;
  timerRemainingMs: number;
  resumeTimerAfterReconnect: boolean;
  emptySince: number | null;
  lastActivity: number;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Ack = (response: RoomAck) => void;

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_ROOM_AGE_MS = 30 * 60 * 1000;
const MAX_CHAT_MESSAGES = 80;
const CHAT_COOLDOWN_MS = 800;
const DISCUSSION_LENGTH_MS = 3 * 60 * 1000;
const rooms = new Map<string, Room>();

function makeRoomCode(): string {
  let code = "";
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () =>
      ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)],
    ).join("");
  } while (rooms.has(code));
  return code;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 24 ? name : null;
}

function validateSettings(value: unknown): RoomSettings | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<RoomSettings>;
  if (input.impostorCount !== 1 && input.impostorCount !== 2) return null;
  if (
    typeof input.allCategories !== "boolean"
    || typeof input.timerEnabled !== "boolean"
    || (input.showImpostorClue !== undefined && typeof input.showImpostorClue !== "boolean")
  ) return null;
  if (!Array.isArray(input.selectedCategories) || !input.selectedCategories.every((item) => typeof item === "string")) return null;
  const selected = [...new Set(input.selectedCategories)];
  if (selected.some((item) => !CATEGORY_NAMES.includes(item))) return null;
  return {
    impostorCount: input.impostorCount,
    allCategories: input.allCategories,
    selectedCategories: input.allCategories ? [...CATEGORY_NAMES] : selected,
    timerEnabled: input.timerEnabled,
    showImpostorClue: input.showImpostorClue ?? false,
  };
}

function ackError(ack: Ack, error: string): void {
  ack({ ok: false, error });
}

function getRoomFor(socket: GameSocket, ack: Ack): Room | null {
  const code = socket.data.roomCode;
  const room = code ? rooms.get(code) : undefined;
  if (!room || !socket.data.playerId || !room.players.some((player) => player.id === socket.data.playerId)) {
    ackError(ack, "You are no longer in that room. Rejoin with the room code.");
    return null;
  }
  return room;
}

function getPlayer(room: Room, playerId: string): Player | undefined {
  return room.players.find((player) => player.id === playerId);
}

function getPublicRoom(room: Room): PublicRoomView {
  const pendingRolePlayerIds = room.phase === "lobby" || room.phase === "results"
    ? []
    : room.players.filter((player) => !room.roleAckIds.has(player.id)).map((player) => player.id);
  const pendingVotePlayerIds = room.phase !== "vote"
    ? []
    : room.players.filter((player) => !room.votes.has(player.id)).map((player) => player.id);
  const timerRemainingMs = room.timerEndsAt
    ? Math.max(0, room.timerEndsAt - Date.now())
    : room.timerRemainingMs;
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    firstSpeakerId: room.firstSpeakerId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      isHost: player.id === room.hostId,
    })),
    settings: room.phase === "lobby"
      ? room.settings
      : { ...room.settings, selectedCategories: [] },
    categoryOptions: CATEGORY_NAMES,
    readyCount: room.players.filter((player) => room.roleAckIds.has(player.id)).length,
    pendingRolePlayerIds,
    pendingVotePlayerIds,
    voteCount: room.votes.size,
    timerEndsAt: room.timerEndsAt,
    timerRemainingMs,
    runoffCount: room.runoffCount,
    tiedPlayerIds: room.tiedPlayerIds,
    candidateIds: room.candidateIds,
    resolvedSuspectId: room.resolvedSuspectId,
    category: null,
    word: null,
    impostorIds: room.phase === "results" ? [...room.impostorIds] : null,
    winner: room.phase === "results" ? room.winner : null,
    voteHistory: room.phase === "results" ? room.voteHistory : null,
  };
}

function getPrivateState(room: Room, playerId: string): PrivatePlayerState | null {
  if (room.phase === "lobby" || !room.category || !room.impostorIds.size) return null;
  const isImpostor = room.impostorIds.has(playerId);
  return {
    role: isImpostor ? "impostor" : "crew",
    word: isImpostor ? null : room.word,
    category: isImpostor && !room.settings.showImpostorClue ? null : room.category,
    roleSeen: room.roleAckIds.has(playerId),
    hasVoted: room.votes.has(playerId),
  };
}

function broadcastRoom(io: GameIO, room: Room): void {
  room.lastActivity = Date.now();
  io.to(room.code).emit("room:state", getPublicRoom(room));
  for (const [playerId, socket] of room.sockets) {
    socket.emit("player:private", getPrivateState(room, playerId));
  }
}

function attachPlayer(io: GameIO, socket: GameSocket, room: Room, player: Player): void {
  const previousSocket = room.sockets.get(player.id);
  if (previousSocket && previousSocket.id !== socket.id) {
    previousSocket.disconnect(true);
  }
  player.connected = true;
  if (!room.players.some((candidate) => candidate.id === room.hostId && candidate.connected)) {
    room.hostId = player.id;
  }
  player.socketId = socket.id;
  room.emptySince = null;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  room.sockets.set(player.id, socket);
  void socket.join(room.code);
  socket.emit("room:chat-history", [...room.chatMessages]);
  const alreadyBroadcast = advanceRoomWhenReady(io, room);
  if (!alreadyBroadcast) broadcastRoom(io, room);
}

function resetRound(room: Room): void {
  room.phase = "lobby";
  room.firstSpeakerId = null;
  room.word = null;
  room.category = null;
  room.impostorIds.clear();
  room.roleAckIds.clear();
  room.votes.clear();
  room.voteHistory = [];
  room.candidateIds = null;
  room.tiedPlayerIds = [];
  room.resolvedSuspectId = null;
  room.winner = null;
  room.runoffCount = 0;
  room.timerEndsAt = null;
  room.timerRemainingMs = DISCUSSION_LENGTH_MS;
  room.resumeTimerAfterReconnect = false;
}

function startVoting(room: Room): void {
  room.phase = "vote";
  room.timerEndsAt = null;
  room.timerRemainingMs = 0;
  room.resumeTimerAfterReconnect = false;
  room.votes.clear();
  room.tiedPlayerIds = [];
}

function startDiscussion(room: Room): void {
  room.phase = "discussion";
  room.timerRemainingMs = room.settings.timerEnabled ? DISCUSSION_LENGTH_MS : 0;
  room.resumeTimerAfterReconnect = false;
}

function finishVoting(io: GameIO, room: Room): void {
  const connectedPlayers = room.players.filter((player) => player.connected);
  const totals = new Map(connectedPlayers.map((player) => [player.id, 0]));
  for (const targetId of room.votes.values()) {
    if (totals.has(targetId)) totals.set(targetId, (totals.get(targetId) ?? 0) + 1);
  }
  const highest = Math.max(0, ...totals.values());
  const leaders = [...totals.entries()]
    .filter(([, count]) => count === highest)
    .map(([playerId]) => playerId);
  room.voteHistory.push({
    label: room.runoffCount ? `Runoff ${room.runoffCount}` : "Main vote",
    ballots: [...room.votes.entries()].map(([voterId, targetId]) => ({ voterId, targetId })),
  });
  if (leaders.length !== 1) {
    room.phase = "tie";
    room.tiedPlayerIds = leaders;
    room.candidateIds = leaders;
    room.votes.clear();
  } else {
    room.phase = "results";
    room.resolvedSuspectId = leaders[0] ?? null;
    room.winner = room.resolvedSuspectId && room.impostorIds.has(room.resolvedSuspectId)
      ? "group"
      : "impostors";
    room.timerEndsAt = null;
  }
  broadcastRoom(io, room);
}

function advanceRoomWhenReady(io: GameIO, room: Room): boolean {
  if (room.players.some((player) => !player.connected)) return false;
  if (room.phase !== "lobby" && room.players.length < 3) {
    resetRound(room);
    return false;
  }
  const currentPlayerIds = new Set(room.players.map((player) => player.id));
  const missingTieCandidate = room.phase === "tie" && room.tiedPlayerIds.some((id) => !currentPlayerIds.has(id));
  const missingRunoffCandidate = room.phase === "vote" && Boolean(room.candidateIds?.some((id) => !currentPlayerIds.has(id)));
  if (missingTieCandidate || missingRunoffCandidate) {
    resetRound(room);
    return false;
  }
  if (room.phase === "lobby" || room.phase === "results") return false;
  if (
    room.phase === "reveal"
    && room.players.length > 0
    && room.players.every((player) => room.roleAckIds.has(player.id))
  ) {
    startDiscussion(room);
  }
  if (room.phase === "discussion" && room.resumeTimerAfterReconnect) {
    room.resumeTimerAfterReconnect = false;
    if (room.settings.timerEnabled) {
      if (room.timerRemainingMs > 0) room.timerEndsAt = Date.now() + room.timerRemainingMs;
      else startVoting(room);
    }
  }
  if (room.phase === "vote" && room.votes.size >= room.players.length) {
    finishVoting(io, room);
    return true;
  }
  return false;
}

function makeRoom(code: string, host: Player, settings: RoomSettings): Room {
  return {
    code,
    hostId: host.id,
    players: [host],
    sockets: new Map(),
    settings,
    firstSpeakerId: null,
    chatMessages: [],
    phase: "lobby",
    word: null,
    category: null,
    impostorIds: new Set(),
    previousImpostorIds: new Set(),
    previousCategory: null,
    usedWordsByCategory: new Map(),
    lastWordByCategory: new Map(),
    previousFirstSpeakerId: null,
    roleAckIds: new Set(),
    votes: new Map(),
    voteHistory: [],
    candidateIds: null,
    tiedPlayerIds: [],
    resolvedSuspectId: null,
    winner: null,
    runoffCount: 0,
    timerEndsAt: null,
    timerRemainingMs: DISCUSSION_LENGTH_MS,
    resumeTimerAfterReconnect: false,
    emptySince: null,
    lastActivity: Date.now(),
  };
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function dealRound(room: Room): void {
  const availableCategories = room.settings.allCategories
    ? CATEGORY_NAMES
    : room.settings.selectedCategories;
  const freshCategories = availableCategories.filter((item) => item !== room.previousCategory);
  const categoryPool = freshCategories.length ? freshCategories : availableCategories;
  const category = categoryPool[randomInt(categoryPool.length)];
  const words = GAME_CATEGORIES[category] ?? GAME_CATEGORIES["Everyday things"];
  const usedWords = room.usedWordsByCategory.get(category) ?? new Set<string>();
  let wordPool = words.filter((item) => !usedWords.has(item));
  if (!wordPool.length) {
    usedWords.clear();
    const lastWord = room.lastWordByCategory.get(category);
    wordPool = lastWord && words.length > 1
      ? words.filter((item) => item !== lastWord)
      : words;
  }
  const word = wordPool[randomInt(wordPool.length)];
  usedWords.add(word);
  room.usedWordsByCategory.set(category, usedWords);
  room.lastWordByCategory.set(category, word);
  room.previousCategory = category;

  const players = shuffle(room.players);
  const impostorCount = Math.min(room.settings.impostorCount, room.players.length - 1);
  const freshImpostors = players.filter((player) => !room.previousImpostorIds.has(player.id));
  const previousImpostors = shuffle(players.filter((player) => room.previousImpostorIds.has(player.id)));
  const selectedImpostors = [
    ...freshImpostors.slice(0, impostorCount),
    ...previousImpostors.slice(0, Math.max(0, impostorCount - freshImpostors.length)),
  ];
  room.category = category;
  room.word = word;
  room.impostorIds = new Set(selectedImpostors.map((player) => player.id));
  room.previousImpostorIds = new Set(room.impostorIds);
  const freshSpeakers = room.players.filter((player) => player.id !== room.previousFirstSpeakerId);
  const speakerPool = freshSpeakers.length ? freshSpeakers : room.players;
  room.firstSpeakerId = speakerPool[randomInt(speakerPool.length)]?.id ?? null;
  room.previousFirstSpeakerId = room.firstSpeakerId;
  room.phase = "reveal";
  room.roleAckIds.clear();
  room.votes.clear();
  room.voteHistory = [];
  room.candidateIds = null;
  room.tiedPlayerIds = [];
  room.resolvedSuspectId = null;
  room.winner = null;
  room.runoffCount = 0;
  room.timerEndsAt = null;
  room.timerRemainingMs = DISCUSSION_LENGTH_MS;
}

type GameIO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export function registerGameSockets(httpServer: HttpServer): void {
  const io: GameIO = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: true, credentials: false },
    pingInterval: 20_000,
    pingTimeout: 25_000,
  });

  io.on("connection", (socket) => {
    socket.on("room:create", (payload, ack) => {
      const name = cleanName(payload?.name);
      const settings = validateSettings(payload);
      if (!name) return ackError(ack, "Enter a name between 1 and 24 characters.");
      if (!settings) return ackError(ack, "Choose valid room settings and at least one category.");
      if (rooms.size >= 500) return ackError(ack, "Too many active rooms. Try again in a moment.");
      const player: Player = { id: randomUUID(), name, socketId: null, connected: true, lastChatAt: 0 };
      const room = makeRoom(makeRoomCode(), player, settings);
      rooms.set(room.code, room);
      attachPlayer(io, socket, room, player);
      ack({ ok: true, code: room.code, playerId: player.id });
    });

    socket.on("room:join", (payload, ack) => {
      const code = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";
      const name = cleanName(payload?.name);
      const room = rooms.get(code);
      if (!name) return ackError(ack, "Enter a name between 1 and 24 characters.");
      if (!room) return ackError(ack, "That room code was not found. Check it and try again.");
      if (room.phase !== "lobby") return ackError(ack, "That game has already started.");
      if (room.players.length >= 12) return ackError(ack, "This room is full.");
      if (room.players.some((player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return ackError(ack, "That name is already in this room.");
      }
      const player: Player = { id: randomUUID(), name, socketId: null, connected: true, lastChatAt: 0 };
      room.players.push(player);
      attachPlayer(io, socket, room, player);
      ack({ ok: true, code: room.code, playerId: player.id });
    });

    socket.on("room:resume", (payload, ack) => {
      const code = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";
      const playerId = typeof payload?.playerId === "string" ? payload.playerId : "";
      const room = rooms.get(code);
      const player = room ? getPlayer(room, playerId) : undefined;
      if (!room || !player) return ackError(ack, "This room has expired. Create or join another room.");
      attachPlayer(io, socket, room, player);
      ack({ ok: true, code: room.code, playerId: player.id });
    });

    socket.on("room:update-settings", (payload, ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      if (socket.data.playerId !== room.hostId) return ackError(ack, "Only the host can change room settings.");
      if (room.phase !== "lobby") return ackError(ack, "Room settings are locked after the game starts.");
      const settings = validateSettings(payload);
      if (!settings) return ackError(ack, "Choose valid room settings and at least one category.");
      room.settings = settings;
      broadcastRoom(io, room);
      ack({ ok: true });
    });

    socket.on("room:chat", (payload, ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) return ackError(ack, "Write a message before sending.");
      if (text.length > 280) return ackError(ack, "Messages must be 280 characters or fewer.");
      const player = getPlayer(room, socket.data.playerId!);
      if (!player) return ackError(ack, "You are no longer in that room.");
      const now = Date.now();
      if (now - player.lastChatAt < CHAT_COOLDOWN_MS) {
        return ackError(ack, "Wait a moment before sending another message.");
      }
      player.lastChatAt = now;
      const message: ChatMessage = {
        id: randomUUID(),
        senderId: player.id,
        senderName: player.name,
        text,
        sentAt: now,
      };
      room.chatMessages.push(message);
      if (room.chatMessages.length > MAX_CHAT_MESSAGES) {
        room.chatMessages.splice(0, room.chatMessages.length - MAX_CHAT_MESSAGES);
      }
      io.to(room.code).emit("room:chat-message", message);
      ack({ ok: true });
    });

    socket.on("room:leave", (ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      const playerId = socket.data.playerId!;
      room.players = room.players.filter((player) => player.id !== playerId);
      room.sockets.delete(playerId);
      room.roleAckIds.delete(playerId);
      for (const [voterId, targetId] of room.votes) {
        if (voterId === playerId || targetId === playerId) room.votes.delete(voterId);
      }
      if (room.hostId === playerId && room.players.length) {
        room.hostId = room.players.find((player) => player.connected)?.id ?? room.players[0].id;
      }
      if (!room.players.length) {
        resetRound(room);
        room.emptySince = Date.now();
      } else {
        room.emptySince = room.players.some((player) => player.connected) ? null : Date.now();
        const alreadyBroadcast = advanceRoomWhenReady(io, room);
        if (!alreadyBroadcast) broadcastRoom(io, room);
      }
      socket.data.roomCode = undefined;
      socket.data.playerId = undefined;
      void socket.leave(room.code);
      ack({ ok: true });
    });

    socket.on("game:start", (ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      if (socket.data.playerId !== room.hostId) return ackError(ack, "Only the host can start the game.");
      if (room.phase !== "lobby") return ackError(ack, "This game has already started.");
      if (room.players.some((player) => !player.connected)) {
        return ackError(ack, "Wait for disconnected players to reconnect or leave before starting.");
      }
      if (room.players.length < 3) return ackError(ack, "Add at least 3 connected players before starting.");
      if (!room.settings.allCategories && room.settings.selectedCategories.length === 0) {
        return ackError(ack, "Select at least one category before starting.");
      }
      dealRound(room);
      broadcastRoom(io, room);
      ack({ ok: true });
    });

    socket.on("game:role-seen", (ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      const playerId = socket.data.playerId!;
      if (!["reveal", "discussion", "vote", "tie"].includes(room.phase)) {
        return ackError(ack, "Role reveal is not active.");
      }
      room.roleAckIds.add(playerId);
      if (
        room.phase === "reveal"
        && room.players.length > 0
        && room.players.every((player) => player.connected && room.roleAckIds.has(player.id))
      ) {
        startDiscussion(room);
      }
      broadcastRoom(io, room);
      ack({ ok: true });
    });

    socket.on("game:discussion", (payload, ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      if (socket.data.playerId !== room.hostId) return ackError(ack, "Only the host can control the discussion.");
      if (room.phase !== "discussion") return ackError(ack, "The discussion phase is not active.");
      if (room.players.some((player) => !player.connected)) {
        return ackError(ack, "The round is paused until everyone reconnects or leaves.");
      }
      const action = payload?.action;
      if (action === "skip") {
        startVoting(room);
      } else if (action === "start" && room.settings.timerEnabled && !room.timerEndsAt && room.timerRemainingMs > 0) {
        room.timerEndsAt = Date.now() + room.timerRemainingMs;
      } else if (action === "pause" && room.timerEndsAt) {
        room.timerRemainingMs = Math.max(0, room.timerEndsAt - Date.now());
        room.timerEndsAt = null;
      } else if (action === "resume" && room.settings.timerEnabled && !room.timerEndsAt && room.timerRemainingMs > 0) {
        room.timerEndsAt = Date.now() + room.timerRemainingMs;
      } else {
        return ackError(ack, "That timer action is not available.");
      }
      broadcastRoom(io, room);
      ack({ ok: true });
    });

    socket.on("game:vote", (payload, ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      const voterId = socket.data.playerId!;
      const targetId = typeof payload?.targetId === "string" ? payload.targetId : "";
      if (room.phase !== "vote") return ackError(ack, "Voting is not active.");
      if (room.players.some((player) => !player.connected)) {
        return ackError(ack, "The round is paused until everyone reconnects or leaves.");
      }
      if (room.votes.has(voterId)) return ackError(ack, "Your vote has already been recorded.");
      if (voterId === targetId || !room.players.some((player) => player.id === targetId && player.connected)) {
        return ackError(ack, "Choose another player from the room.");
      }
      if (room.candidateIds && !room.candidateIds.includes(targetId)) {
        return ackError(ack, "Runoff votes must go to one of the tied players.");
      }
      room.votes.set(voterId, targetId);
      if (room.votes.size >= room.players.length) {
        finishVoting(io, room);
      } else {
        broadcastRoom(io, room);
      }
      ack({ ok: true });
    });

    socket.on("game:start-runoff", (ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      if (socket.data.playerId !== room.hostId) return ackError(ack, "Only the host can start a runoff.");
      if (room.phase !== "tie" || room.tiedPlayerIds.length < 2) {
        return ackError(ack, "There is no tied vote to resolve.");
      }
      if (room.players.some((player) => !player.connected)) {
        return ackError(ack, "The round is paused until everyone reconnects or leaves.");
      }
      room.candidateIds = [...room.tiedPlayerIds];
      room.runoffCount += 1;
      startVoting(room);
      broadcastRoom(io, room);
      ack({ ok: true });
    });

    socket.on("game:play-again", (ack) => {
      const room = getRoomFor(socket, ack);
      if (!room) return;
      if (socket.data.playerId !== room.hostId) return ackError(ack, "Only the host can deal another round.");
      if (room.phase !== "results") return ackError(ack, "Finish the current round first.");
      if (room.players.some((player) => !player.connected)) {
        return ackError(ack, "Wait for disconnected players to reconnect or leave before playing again.");
      }
      if (room.players.length < 3) {
        resetRound(room);
        broadcastRoom(io, room);
        ack({ ok: true });
        return;
      }
      dealRound(room);
      broadcastRoom(io, room);
      ack({ ok: true });
    });

    socket.on("disconnect", () => {
      const code = socket.data.roomCode;
      const playerId = socket.data.playerId;
      if (!code || !playerId) return;
      const room = rooms.get(code);
      const player = room ? getPlayer(room, playerId) : undefined;
      if (!room || !player || player.socketId !== socket.id) return;
      player.connected = false;
      player.socketId = null;
      room.sockets.delete(playerId);
      if (room.phase === "discussion" && room.timerEndsAt) {
        room.timerRemainingMs = Math.max(0, room.timerEndsAt - Date.now());
        room.timerEndsAt = null;
        room.resumeTimerAfterReconnect = true;
      }
      if (room.hostId === playerId) {
        room.hostId = room.players.find((candidate) => candidate.connected)?.id ?? playerId;
      }
      if (!room.players.some((candidate) => candidate.connected)) room.emptySince = Date.now();
      else room.emptySince = null;
      broadcastRoom(io, room);
    });
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.emptySince && now - room.emptySince > MAX_ROOM_AGE_MS) {
        rooms.delete(room.code);
        continue;
      }
      if (room.phase === "discussion" && room.timerEndsAt && room.timerEndsAt <= now) {
        if (room.players.some((player) => !player.connected)) {
          room.timerRemainingMs = 0;
          room.timerEndsAt = null;
          room.resumeTimerAfterReconnect = true;
          broadcastRoom(io, room);
          continue;
        }
        startVoting(room);
        broadcastRoom(io, room);
      }
    }
  }, 1000);

  httpServer.on("close", () => {
    clearInterval(timer);
    io.close();
  });
}
