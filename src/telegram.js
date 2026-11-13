/**
 * Minimal zero-dependency Telegram Bot client with inline choice keyboards.
 */
export class TelegramController {
  constructor(config, handlers) {
    this.token = config.telegramToken;
    this.chatId = String(config.telegramChatId || '');
    this.handlers = handlers;
    this.offset = 0;
    this.pendingChoices = new Map();
    this.seq = 0;
    this.running = false;
  }

  async api(method, body = {}) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  async send(text, extra = {}) {
    if (!this.token || !this.chatId) return null;
    return this.api('sendMessage', {
      chat_id: this.chatId,
      text: String(text).slice(0, 4000),
      ...extra
    });
  }

  /**
   * Send a clickable choice prompt and await user's selection.
   */
  askChoice(question, options, allowMultiple = false) {
    const qid = `q${++this.seq}`;
    const state = {
      question,
      options,
      allowMultiple,
      selected: new Set(),
      resolve: null
    };

    const promise = new Promise((resolve) => {
      state.resolve = resolve;
    });

    this.pendingChoices.set(qid, state);
    this.send(question, { reply_markup: this.buildKeyboard(qid, state) }).catch((err) => {
      console.error('Telegram askChoice send error:', err.message);
    });
    return promise;
  }

  buildKeyboard(qid, state) {
    const rows = state.options.map((opt, idx) => {
      const prefix = state.allowMultiple ? (state.selected.has(idx) ? '[✓] ' : '[ ] ') : '';
      return [{ text: `${prefix}${opt}`, callback_data: `sel:${qid}:${idx}` }];
    });
    if (state.allowMultiple) {
      rows.push([{ text: 'ยืนยันคำตอบ (Submit)', callback_data: `sub:${qid}` }]);
    }
    return { inline_keyboard: rows };
  }

  async handleCallback(cb) {
    const chatId = String(cb.message?.chat?.id || '');
    if (chatId !== this.chatId) {
      await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unauthorized' });
      return;
    }

    const [kind, qid, idxStr] = String(cb.data || '').split(':');
    const pending = this.pendingChoices.get(qid);
    if (!pending) {
      await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Expired' });
      return;
    }

    if (kind === 'sel') {
      const idx = Number(idxStr);
      if (!pending.allowMultiple) {
        const answer = pending.options[idx];
        this.pendingChoices.delete(qid);
        await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: answer });
        await this.api('editMessageText', {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: `${pending.question}\n-> ${answer}`
        });
        pending.resolve(answer);
        return;
      }

      if (pending.selected.has(idx)) pending.selected.delete(idx);
      else pending.selected.add(idx);

      await this.api('answerCallbackQuery', { callback_query_id: cb.id });
      await this.api('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: this.buildKeyboard(qid, pending)
      });
      return;
    }

    if (kind === 'sub') {
      const picked = [...pending.selected].sort((a, b) => a - b).map((i) => pending.options[i]);
      const answer = picked.length ? picked.join(', ') : pending.options[0];
      this.pendingChoices.delete(qid);
      await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Confirmed' });
      await this.api('editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: `${pending.question}\n-> ${answer}`
      });
      pending.resolve(answer);
    }
  }

  async handleMessage(msg) {
    const chatId = String(msg.chat?.id || '');
    if (!this.chatId || chatId !== this.chatId) {
      await this.api('sendMessage', {
        chat_id: chatId,
        text: `Unauthorized. Set TELEGRAM_CHAT_ID=${chatId} in .env`
      });
      return;
    }

    const text = String(msg.text || '').trim();
    if (!text) return;
    await this.handlers.onCommand(text);
  }

  async startPolling() {
    this.running = true;
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 25
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) await this.handleCallback(u.callback_query);
          else if (u.message) await this.handleMessage(u.message);
        }
      } catch (err) {
        console.error('Telegram poll error:', err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
