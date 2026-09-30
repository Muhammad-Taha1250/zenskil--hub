import { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, extractBaileysContent, mapBaileysStatus, normalizeBaileysMessage } from './baileys.client';
import makeWASocketMock from '../../test/mocks/baileys.mock';
import { toWhatsappJid } from './whatsapp-client.interface';

// Baileys inbound normalization: pure helpers, no socket needed.
const wam = (overrides: Partial<WAMessage> = {}): WAMessage =>
  ({
    key: { id: 'WA.123', remoteJid: '923001234567@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1720000000,
    message: { conversation: 'Hi' },
    ...overrides,
  }) as WAMessage;

describe('normalizeBaileysMessage', () => {
  it('normalizes a plain text message', () => {
    const msg = normalizeBaileysMessage(wam());
    expect(msg?.type).toBe('text');
    expect(msg?.text).toBe('Hi');
    expect(msg?.from).toBe('923001234567'); // digits only
    expect(msg?.providerMessageId).toBe('WA.123');
    expect(msg?.timestamp).toEqual(new Date(1720000000 * 1000));
  });

  it('normalizes extended text', () => {
    const msg = normalizeBaileysMessage(
      wam({ message: { extendedTextMessage: { text: 'Hello there' } } }),
    );
    expect(msg?.type).toBe('text');
    expect(msg?.text).toBe('Hello there');
  });

  it('normalizes an image with caption; mediaId is the message id', () => {
    const msg = normalizeBaileysMessage(
      wam({
        key: { id: 'WA.IMG', remoteJid: '923001234567@s.whatsapp.net', fromMe: false },
        message: { imageMessage: { caption: 'receipt', mimetype: 'image/jpeg' } },
      }),
    );
    expect(msg?.type).toBe('image');
    expect(msg?.caption).toBe('receipt');
    expect(msg?.mediaMimeType).toBe('image/jpeg');
    expect(msg?.mediaId).toBe('WA.IMG'); // Baileys: WA id doubles as media handle
  });

  it('normalizes button and list responses with buttonId', () => {
    const btn = normalizeBaileysMessage(
      wam({ message: { buttonsResponseMessage: { selectedButtonId: 'PLAN_3M', selectedDisplayText: '3 Months' } } }),
    );
    expect(btn?.type).toBe('button_reply');
    expect(btn?.buttonId).toBe('PLAN_3M');
    expect(btn?.text).toBe('3 Months');

    const list = normalizeBaileysMessage(
      wam({ message: { listResponseMessage: { title: 'Urdu', singleSelectReply: { selectedRowId: 'LANG_UR' } } } }),
    );
    expect(list?.type).toBe('button_reply');
    expect(list?.buttonId).toBe('LANG_UR');
  });

  it('drops status broadcasts and messages with no id or sender', () => {
    expect(
      normalizeBaileysMessage(wam({ key: { id: 'WA.1', remoteJid: 'status@broadcast', fromMe: false } })),
    ).toBeNull();
    expect(normalizeBaileysMessage(wam({ key: { remoteJid: '923001234567@s.whatsapp.net' } as WAMessage['key'] }))).toBeNull();
    expect(normalizeBaileysMessage(wam({ key: { id: 'WA.2' } as WAMessage['key'] }))).toBeNull();
  });

  it('rejects group JIDs (@g.us) — groups are unsupported', () => {
    expect(
      normalizeBaileysMessage(
        wam({ key: { id: 'WA.G', remoteJid: '120363012345@g.us', fromMe: false } }),
      ),
    ).toBeNull();
  });

  it('rejects @lid JIDs — never strip opaque LIDs into fake phone numbers', () => {
    // A LID's user part is NOT a phone number; accepting it would create a
    // customer keyed on a fabricated number and misroute replies.
    expect(
      normalizeBaileysMessage(
        wam({ key: { id: 'WA.L', remoteJid: '123456789012345@lid', fromMe: false } }),
      ),
    ).toBeNull();
  });

  it('rejects malformed and unknown-server JIDs', () => {
    expect(
      normalizeBaileysMessage(wam({ key: { id: 'WA.M', remoteJid: 'not-a-jid', fromMe: false } })),
    ).toBeNull();
    expect(
      normalizeBaileysMessage(
        wam({ key: { id: 'WA.S', remoteJid: '923001234567@something.else', fromMe: false } }),
      ),
    ).toBeNull();
  });
});

describe('extractBaileysContent', () => {
  it('returns {} for empty content', () => {
    expect(extractBaileysContent(null)).toEqual({});
    expect(extractBaileysContent(undefined)).toEqual({});
  });

  it('extracts document/video/audio kinds', () => {
    expect(extractBaileysContent({ documentMessage: { mimetype: 'application/pdf' } }).mediaKind).toBe('document');
    expect(extractBaileysContent({ videoMessage: { mimetype: 'video/mp4' } }).mediaKind).toBe('video');
    expect(extractBaileysContent({ audioMessage: { mimetype: 'audio/ogg' } }).mediaKind).toBe('audio');
  });
});

describe('mapBaileysStatus', () => {
  it('maps receipt statuses to the provider vocabulary', () => {
    expect(mapBaileysStatus(2)).toBe('sent'); // SERVER_ACK
    expect(mapBaileysStatus(3)).toBe('delivered'); // DELIVERY_ACK
    expect(mapBaileysStatus(4)).toBe('read'); // READ
    expect(mapBaileysStatus(5)).toBe('read'); // PLAYED
    expect(mapBaileysStatus(0)).toBeNull();
    expect(mapBaileysStatus(undefined)).toBeNull();
  });
});

describe('toWhatsappJid', () => {
  it('formats E.164 digits to a JID', () => {
    expect(toWhatsappJid('923001234567')).toBe('923001234567@s.whatsapp.net');
    expect(toWhatsappJid('+92 300 1234567')).toBe('923001234567@s.whatsapp.net');
    expect(toWhatsappJid('03001234567')).toBe('923001234567@s.whatsapp.net');
  });
});

describe('BaileysClient connection lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  const newClient = (): BaileysClient => {
    const config = {
      get: (key: string) =>
        ({ BAILEYS_AUTH_DIR: '/tmp/baileys-test-auth', BAILEYS_LOG_LEVEL: 'silent' })[key],
    } as never;
    return new BaileysClient(config);
  };

  const boomLike = (statusCode: number): Error => {
    const err = new Error(`disconnect ${statusCode}`) as Error & { output: { statusCode: number } };
    err.output = { statusCode };
    return err;
  };

  it('reconnects after a non-logout disconnect', async () => {
    const client = newClient();
    await (client as unknown as { connect: () => Promise<void> }).connect();
    const callsAfterFirst = makeWASocketMock.mock.calls.length;
    await (client as unknown as { onConnectionUpdate: (u: unknown) => Promise<void> }).onConnectionUpdate({
      connection: 'close',
      lastDisconnect: { error: boomLike(428) }, // connectionClosed
    });
    expect(makeWASocketMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(client.connected).toBe(false);
  }, 15000);

  it('does NOT reconnect after logout (401) — operator must wipe auth and re-scan', async () => {
    const client = newClient();
    await (client as unknown as { connect: () => Promise<void> }).connect();
    const callsAfterFirst = makeWASocketMock.mock.calls.length;
    await (client as unknown as { onConnectionUpdate: (u: unknown) => Promise<void> }).onConnectionUpdate({
      connection: 'close',
      lastDisconnect: { error: boomLike(401) }, // loggedOut
    });
    expect(makeWASocketMock.mock.calls.length).toBe(callsAfterFirst);
    expect(client.connected).toBe(false);
  });

  it('marks the socket connected on open and clears QR pending', async () => {
    const client = newClient();
    const update = client as unknown as { onConnectionUpdate: (u: unknown) => Promise<void> };
    await update.onConnectionUpdate({ qr: 'fake-qr' });
    expect(client.awaitingQrScan).toBe(true);
    await update.onConnectionUpdate({ connection: 'open' });
    expect(client.connected).toBe(true);
    expect(client.awaitingQrScan).toBe(false);
  });

  it('routes an inbound upsert to registered handlers (skips fromMe/history)', async () => {
    const client = newClient();
    const seen: unknown[] = [];
    client.onInbound((m) => void seen.push(m));
    const drive = (client as unknown as { onMessagesUpsert: (u: unknown) => Promise<void> }).onMessagesUpsert.bind(client);
    await drive({ messages: [wam()], type: 'notify' });
    expect(seen).toHaveLength(1);
    await drive({ messages: [wam()], type: 'append' }); // history sync
    await drive({ messages: [wam({ key: { id: 'WA.ME', remoteJid: '923001234567@s.whatsapp.net', fromMe: true } })], type: 'notify' });
    expect(seen).toHaveLength(1); // still 1 — both ignored
  });

  it('drops group/@lid upserts before handlers — no fake customers', async () => {
    const client = newClient();
    const seen: unknown[] = [];
    client.onInbound((m) => void seen.push(m));
    const drive = (client as unknown as { onMessagesUpsert: (u: unknown) => Promise<void> }).onMessagesUpsert.bind(client);
    await drive({ messages: [wam({ key: { id: 'WA.G', remoteJid: '120363012345@g.us', fromMe: false } })], type: 'notify' });
    await drive({ messages: [wam({ key: { id: 'WA.L', remoteJid: '123456789012345@lid', fromMe: false } })], type: 'notify' });
    expect(seen).toHaveLength(0);
  });

  it('registers creds.update -> saveCreds on connect', async () => {
    const client = newClient();
    await (client as unknown as { connect: () => Promise<void> }).connect();
    const sock = makeWASocketMock.mock.results.at(-1)!.value as { ev: { on: jest.Mock } };
    const credsHandler = sock.ev.on.mock.calls.find(([ev]) => ev === 'creds.update')?.[1];
    expect(typeof credsHandler).toBe('function');
  });

  it('sendText calls sock.sendMessage with <digits>@s.whatsapp.net and the exact body', async () => {
    const client = newClient();
    await (client as unknown as { connect: () => Promise<void> }).connect();
    const res = await client.sendText({ to: '+92 300 1234567', body: 'Hello there', kind: 'transactional' });
    const sock = makeWASocketMock.mock.results.at(-1)!.value as { sendMessage: jest.Mock };
    expect(sock.sendMessage).toHaveBeenCalledWith('923001234567@s.whatsapp.net', { text: 'Hello there' });
    expect(res.providerMessageId).toBe('WA.MOCK');
  });

  it('sendTemplate sends the rendered body (never bare variables)', async () => {
    const client = newClient();
    await (client as unknown as { connect: () => Promise<void> }).connect();
    await client.sendTemplate({
      to: '923001234567', templateName: 't', languageCode: 'en',
      variables: ['a', 'b'], renderedBody: 'Full rendered message',
    });
    const sock = makeWASocketMock.mock.results.at(-1)!.value as { sendMessage: jest.Mock };
    expect(sock.sendMessage).toHaveBeenCalledWith('923001234567@s.whatsapp.net', { text: 'Full rendered message' });
  });

  it('sends fail fast with BaileysError when no socket is connected', async () => {
    const client = newClient(); // never connected
    await expect(
      client.sendText({ to: '923001234567', body: 'x', kind: 'transactional' }),
    ).rejects.toMatchObject({ name: 'BaileysError', retryable: true });
  });

  it('sendMedia with uncached media fails with a clear error', async () => {
    const client = newClient();
    await (client as unknown as { connect: () => Promise<void> }).connect();
    await expect(
      client.sendMedia({ to: '923001234567', mediaId: 'WA.NOCACHE', mimeType: 'image/jpeg', kind: 'transactional' }),
    ).rejects.toThrow(/media/i);
  });

  it('sendInteractive degrades to numbered text (no Cloud buttons on Baileys)', async () => {
    const client = newClient();
    await (client as unknown as { connect: () => Promise<void> }).connect();
    await client.sendInteractive({
      to: '923001234567',
      body: 'What would you like to do?',
      buttons: [
        { id: 'menu:plans', title: 'View plans' },
        { id: 'menu:orders', title: 'My orders' },
      ],
      kind: 'transactional',
    });
    const sock = makeWASocketMock.mock.results.at(-1)!.value as { sendMessage: jest.Mock };
    const [jid, content] = sock.sendMessage.mock.calls.at(-1)!;
    expect(jid).toBe('923001234567@s.whatsapp.net');
    // Numbered list the customer can answer with a bare digit — the
    // conversation router maps "1"/"2"/"3" and parseInt() choices as text.
    expect(content.text).toContain('1. View plans');
    expect(content.text).toContain('2. My orders');
  });
});
