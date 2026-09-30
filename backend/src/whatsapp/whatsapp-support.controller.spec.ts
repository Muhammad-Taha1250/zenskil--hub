import { WhatsappSupportController } from './whatsapp-support.controller';

function mockSupport() {
  return {
    getTicket: jest.fn().mockResolvedValue({ id: 't1', customerId: 'c1' }),
    addMessage: jest.fn().mockResolvedValue({ id: 'm1', bodyText: 'Hello' }),
  };
}

function mockWhatsapp() {
  return {
    sendAdminTextToCustomer: jest.fn().mockResolvedValue({ delivered: true, messageId: 'wamid.1' }),
  };
}

const admin = { id: 'admin1' } as never;
const req = { ip: '127.0.0.1' } as never;

describe('WhatsappSupportController.reply', () => {
  it('stores the AGENT message in the thread, then attempts WhatsApp delivery', async () => {
    const support = mockSupport();
    const whatsapp = mockWhatsapp();
    const ctl = new WhatsappSupportController(support as never, whatsapp as never);
    const res = await ctl.reply('t1', { bodyText: 'Hello' }, admin, req);
    expect(support.getTicket).toHaveBeenCalledWith('t1');
    expect(support.addMessage).toHaveBeenCalledWith(
      't1', 'AGENT', 'admin1', 'Hello',
      { type: 'ADMIN', id: 'admin1', ip: '127.0.0.1' },
    );
    expect(whatsapp.sendAdminTextToCustomer).toHaveBeenCalledWith(
      'c1', 'Hello', { type: 'ADMIN', id: 'admin1', ip: '127.0.0.1' },
    );
    expect(res).toEqual({
      message: { id: 'm1', bodyText: 'Hello' },
      whatsapp: { delivered: true, messageId: 'wamid.1' },
    });
  });

  it('reports a policy block honestly instead of inventing delivery', async () => {
    const support = mockSupport();
    const whatsapp = mockWhatsapp();
    whatsapp.sendAdminTextToCustomer.mockResolvedValue({ delivered: false, reason: 'free_form_outside_24h_window' });
    const ctl = new WhatsappSupportController(support as never, whatsapp as never);
    const res = await ctl.reply('t1', { bodyText: 'Hello' }, admin, req);
    // Thread record still exists (honest record), delivery verdict is explicit.
    expect(support.addMessage).toHaveBeenCalled();
    expect(res.whatsapp).toEqual({ delivered: false, reason: 'free_form_outside_24h_window' });
  });

  it('propagates a missing ticket as an error (no phantom thread write)', async () => {
    const support = mockSupport();
    support.getTicket.mockRejectedValue(new Error('Ticket not found'));
    const whatsapp = mockWhatsapp();
    const ctl = new WhatsappSupportController(support as never, whatsapp as never);
    await expect(ctl.reply('nope', { bodyText: 'Hello' }, admin, req)).rejects.toThrow('Ticket not found');
    expect(support.addMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendAdminTextToCustomer).not.toHaveBeenCalled();
  });
});
