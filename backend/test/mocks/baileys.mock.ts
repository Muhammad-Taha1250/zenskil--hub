// Jest manual mock for @whiskeysockets/baileys (ESM-only build breaks
// jest's CJS resolver; unit tests must never open a real socket anyway).
// Enum values mirror baileys 6.7.x exactly — verified against the real
// package (proto.WebMessageInfo.Status, DisconnectReason).
export const DisconnectReason = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
};

export const proto = {
  WebMessageInfo: {
    Status: { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 },
  },
};

export const fetchLatestBaileysVersion = jest.fn(async () => ({
  version: [2, 3000, 1025] as [number, number, number],
  isLatest: true,
}));

export const useMultiFileAuthState = jest.fn(async () => ({
  state: { creds: { registered: false }, keys: {} },
  saveCreds: jest.fn(async () => undefined),
}));

export const makeCacheableSignalKeyStore = jest.fn((keys: unknown) => keys);

export const downloadMediaMessage = jest.fn(async () => Buffer.from([]));

const makeWASocketMock = jest.fn(() => ({
  ev: { on: jest.fn(), off: jest.fn(), removeAllListeners: jest.fn() },
  sendMessage: jest.fn(async () => ({ key: { id: 'WA.MOCK' } })),
  readMessages: jest.fn(async () => undefined),
  ws: { close: jest.fn() },
  end: jest.fn(),
}));

export default makeWASocketMock;
export const makeWASocket = makeWASocketMock;
