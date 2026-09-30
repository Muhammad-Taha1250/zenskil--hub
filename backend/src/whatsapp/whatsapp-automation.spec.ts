import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaileysClient } from './baileys.client';
import { WhatsappAutomationController } from './whatsapp-automation.controller';
import { WhatsappAutomationGuard } from './whatsapp-automation.guard';
import { WhatsappService } from './whatsapp.service';

// ---------------------------------------------------------------------------
// BaileysClient: public connection state + QR data-URI
// ---------------------------------------------------------------------------

describe('BaileysClient automation surface', () => {
  const newClient = (): BaileysClient => {
    const config = {
      get: (key: string) =>
        ({ BAILEYS_AUTH_DIR: '/tmp/baileys-test-auth', BAILEYS_LOG_LEVEL: 'silent' })[key],
    } as never;
    return new BaileysClient(config);
  };
  const updateOf = (client: BaileysClient) =>
    client as unknown as { onConnectionUpdate: (u: unknown) => Promise<void> };

  it('starts DISCONNECTED with no QR', async () => {
    const client = newClient();
    expect(client.getConnectionState()).toBe('DISCONNECTED');
    await expect(client.getQrDataUri()).resolves.toBeNull();
  });

  it('reports QR_READY and serves a PNG data-URI after a qr event', async () => {
    const client = newClient();
    await updateOf(client).onConnectionUpdate({ qr: 'pairing-qr-string' });
    expect(client.getConnectionState()).toBe('QR_READY');
    const uri = await client.getQrDataUri();
    expect(uri).toMatch(/^data:image\/png;base64,/);
    // Cached per QR string.
    await expect(client.getQrDataUri()).resolves.toBe(uri);
  });

  it('reports CONNECTING while the socket negotiates', async () => {
    const client = newClient();
    await updateOf(client).onConnectionUpdate({ connection: 'connecting' });
    expect(client.getConnectionState()).toBe('CONNECTING');
  });

  it('reports CONNECTED on open and clears the pending QR', async () => {
    const client = newClient();
    const update = updateOf(client);
    await update.onConnectionUpdate({ qr: 'pairing-qr-string' });
    expect(await client.getQrDataUri()).not.toBeNull();
    await update.onConnectionUpdate({ connection: 'open' });
    expect(client.getConnectionState()).toBe('CONNECTED');
    await expect(client.getQrDataUri()).resolves.toBeNull();
  });

  it('reports DISCONNECTED after a close (and reconnects in the background)', async () => {
    const client = newClient();
    const update = updateOf(client);
    await update.onConnectionUpdate({ connection: 'open' });
    expect(client.getConnectionState()).toBe('CONNECTED');
    // Await the full close handling: 2s backoff + reconnect attempt against
    // the mocked socket, which never auto-opens — state stays DISCONNECTED.
    await update.onConnectionUpdate({ connection: 'close' });
    expect(client.getConnectionState()).toBe('DISCONNECTED');
  }, 15000);
});

// ---------------------------------------------------------------------------
// WhatsappAutomationGuard
// ---------------------------------------------------------------------------

describe('WhatsappAutomationGuard', () => {
  const TOKEN = 'test-automation-token';
  let saved: string | undefined;

  const ctxFor = (headers: Record<string, string> = {}, query: Record<string, string> = {}) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers, query }) }),
    }) as never;

  beforeEach(() => {
    saved = process.env.AUTOMATION_SERVICE_TOKEN;
    process.env.AUTOMATION_SERVICE_TOKEN = TOKEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTOMATION_SERVICE_TOKEN;
    else process.env.AUTOMATION_SERVICE_TOKEN = saved;
  });

  it('fails closed with 503 when AUTOMATION_SERVICE_TOKEN is unset', () => {
    delete process.env.AUTOMATION_SERVICE_TOKEN;
    expect(() => new WhatsappAutomationGuard().canActivate(ctxFor())).toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects a wrong header token with 401', () => {
    expect(() =>
      new WhatsappAutomationGuard().canActivate(ctxFor({ 'x-service-token': 'nope' })),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('rejects when no token is supplied at all', () => {
    expect(() => new WhatsappAutomationGuard().canActivate(ctxFor())).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('prefers the header: wrong header beats a correct query token', () => {
    expect(() =>
      new WhatsappAutomationGuard().canActivate(
        ctxFor({ 'x-service-token': 'nope' }, { token: TOKEN }),
      ),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('accepts the correct x-service-token header', () => {
    expect(
      new WhatsappAutomationGuard().canActivate(ctxFor({ 'x-service-token': TOKEN })),
    ).toBe(true);
  });

  it('accepts the token as ?token= for browser use', () => {
    expect(
      new WhatsappAutomationGuard().canActivate(ctxFor({}, { token: TOKEN })),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WhatsappAutomationController
// ---------------------------------------------------------------------------

describe('WhatsappAutomationController', () => {
  const TOKEN = 'test-automation-token';

  const mocks = () => {
    const baileys = {
      connected: true,
      getConnectionState: jest.fn(),
      getQrDataUri: jest.fn(),
    };
    const whatsapp = { sendAutomationText: jest.fn() };
    const controller = new WhatsappAutomationController(
      baileys as unknown as BaileysClient,
      whatsapp as unknown as WhatsappService,
    );
    return { baileys, whatsapp, controller };
  };

  describe('GET /whatsapp/status', () => {
    it.each([['CONNECTED'], ['DISCONNECTED'], ['CONNECTING'], ['QR_READY']])(
      'reports state %s',
      (state) => {
        const { baileys, controller } = mocks();
        baileys.getConnectionState.mockReturnValue(state);
        const res = controller.status();
        expect(res.state).toBe(state);
        expect(res.connected).toBe(state === 'CONNECTED');
        expect(res.clientName).toBe('baileys');
      },
    );
  });

  describe('GET /whatsapp/qr', () => {
    it('shows an already-linked page when connected', async () => {
      const { baileys, controller } = mocks();
      baileys.getConnectionState.mockReturnValue('CONNECTED');
      const html = await controller.qr();
      expect(html).toContain('already linked');
      expect(baileys.getQrDataUri).not.toHaveBeenCalled();
    });

    it('embeds the QR data-URI as an image when pairing', async () => {
      const { baileys, controller } = mocks();
      baileys.getConnectionState.mockReturnValue('QR_READY');
      baileys.getQrDataUri.mockResolvedValue('data:image/png;base64,AAAA');
      const html = await controller.qr();
      expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    });

    it('throws 404 when no QR is pending', async () => {
      const { baileys, controller } = mocks();
      baileys.getConnectionState.mockReturnValue('CONNECTING');
      baileys.getQrDataUri.mockResolvedValue(null);
      await expect(controller.qr()).rejects.toThrow(NotFoundException);
    });
  });

  describe('POST /whatsapp/send', () => {
    it('normalizes local format and returns the JID', async () => {
      const { baileys, whatsapp, controller } = mocks();
      whatsapp.sendAutomationText.mockResolvedValue({ providerMessageId: 'WA.1' });
      const res = await controller.send({ to: '03001234567', message: 'hello' });
      expect(whatsapp.sendAutomationText).toHaveBeenCalledWith('923001234567', 'hello');
      expect(res).toEqual({
        ok: true,
        to: '923001234567',
        jid: '923001234567@s.whatsapp.net',
        providerMessageId: 'WA.1',
      });
      expect(baileys.connected).toBe(true);
    });

    it('strips non-digits and plus signs', async () => {
      const { whatsapp, controller } = mocks();
      whatsapp.sendAutomationText.mockResolvedValue({ providerMessageId: 'WA.2' });
      await controller.send({ to: '+92 300-123 4567', message: 'hi' });
      expect(whatsapp.sendAutomationText).toHaveBeenCalledWith('923001234567', 'hi');
    });

    it('throws 400 when nothing dialable remains', async () => {
      const { controller } = mocks();
      await expect(controller.send({ to: '+++', message: 'hi' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws 503 when the socket is down', async () => {
      const { baileys, whatsapp, controller } = mocks();
      (baileys as { connected: boolean }).connected = false;
      await expect(controller.send({ to: '923001234567', message: 'hi' })).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(whatsapp.sendAutomationText).not.toHaveBeenCalled();
    });
  });

  // The guard is applied via decorators; the token constant here only
  // documents the wiring — behavior is covered above.
  it('documents the expected token env', () => {
    expect(TOKEN).toBe('test-automation-token');
  });
});
