import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Minimal zero-dependency Telegram Bot client with inline keyboards, custom text input, cancel, and photo support.
 */
export class TelegramController {
  constructor(config, handlers) {
    this.token = config.telegramToken;
    this.chatId = String(config.telegramChatId || '');
    this.handlers = handlers;
    this.offset = 0;
    this.pendingChoices = new Map();
    this.awaitingTextQid = null;
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

  async sendMedia(endpoint, field, filePath, filename, mime, caption = '') {
    if (!this.token || !this.chatId || !filePath || !fs.existsSync(filePath)) return null;
    const form = new FormData();
    form.append('chat_id', this.chatId);
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    form.append(field, new Blob([fs.readFileSync(filePath)], { type: mime }), filename);

    const res = await fetch(`https://api.telegram.org/bot${this.token}/${endpoint}`, {
      method: 'POST',
      body: form
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${endpoint}: ${data.description}`);
    return data.result;
  }

  sendPhoto(filePath, caption = '') {
    return this.sendMedia('sendPhoto', 'photo', filePath, 'preview.png', 'image/png', caption);
  }

  sendDocument(filePath, filename = 'project.zip', caption = '', mime = 'application/zip') {
    return this.sendMedia('sendDocument', 'document', filePath, filename, mime, caption);
  }

  /**
   * Send a clickable choice prompt (with optional custom text & cancel buttons) and await user's answer.
   */
  askChoice(question, options, allowMultiple = false, { allowCustom = true, allowCancel = true } = {}) {
    const qid = `q${++this.seq}`;
    const state = {
      question,
      options,
      allowMultiple,
      allowCustom,
      allowCancel,
      selected: new Set(),
      resolve: null,
      reject: null
    };

    const promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });

    this.pendingChoices.set(qid, state);
    this.send(question, { reply_markup: this.buildKeyboard(qid, state) })
      .then((sent) => {
        if (sent?.message_id) state.messageId = sent.message_id;
      })
      .catch((err) => {
        console.error('Telegram askChoice send error:', err.message);
      });
    return { qid, promise };
  }

  resolveExternal(qid, answer, isCancel = false) {
    const pending = this.pendingChoices.get(qid);
    if (!pending) return;
    this.pendingChoices.delete(qid);
    if (this.awaitingTextQid === qid) this.awaitingTextQid = null;
    if (pending.messageId && this.token && this.chatId) {
      this.api('editMessageText', {
        chat_id: this.chatId,
        message_id: pending.messageId,
        text: `${pending.question}\n-> ${isCancel ? '❌ ยกเลิกผ่าน Web Dashboard' : `${answer} (ตอบผ่าน Web Dashboard)`}`
      }).catch(() => {});
    }
    if (isCancel) pending.reject(new Error('Cancelled by user'));
    else pending.resolve(answer);
  }

  cancelPending(reason = 'Cancelled by user') {
    this.awaitingTextQid = null;
    for (const [qid, pending] of this.pendingChoices.entries()) {
      this.pendingChoices.delete(qid);
      pending.reject(new Error(reason));
    }
  }

  buildKeyboard(qid, state) {
    const rows = state.options.map((opt, idx) => {
      const prefix = state.allowMultiple ? (state.selected.has(idx) ? '[✓] ' : '[ ] ') : '';
      return [{ text: `${prefix}${opt}`, callback_data: `sel:${qid}:${idx}` }];
    });
    if (state.allowMultiple) {
      rows.push([{ text: '✅ ยืนยันคำตอบ (Submit)', callback_data: `sub:${qid}` }]);
    }
    const actions = [];
    if (state.allowCustom) actions.push({ text: '✏️ พิมพ์ตอบเอง', callback_data: `cus:${qid}` });
    if (state.allowCancel) actions.push({ text: '❌ ยกเลิกงาน', callback_data: `can:${qid}` });
    if (actions.length) rows.push(actions);
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

    if (kind === 'can') {
      this.pendingChoices.delete(qid);
      if (this.awaitingTextQid === qid) this.awaitingTextQid = null;
      await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Cancelled' });
      await this.api('editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: `${pending.question}\n-> ❌ ยกเลิกแล้ว`
      });
      pending.reject(new Error('Cancelled by user'));
      return;
    }

    if (kind === 'cus') {
      this.awaitingTextQid = qid;
      await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'พิมพ์คำตอบส่งมาในแชทได้เลย' });
      await this.api('editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: `${pending.question}\n\n✏️ กรุณาพิมพ์คำตอบของคุณส่งมาในแชทได้เลยครับ`
      });
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

  async downloadFile(fileId, ext = 'bin') {
    const info = await this.api('getFile', { file_id: fileId });
    const fileUrl = `https://api.telegram.org/file/bot${this.token}/${info.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const outPath = path.join(os.tmpdir(), `dualloop-tg-${Date.now()}.${ext}`);
    fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
    return outPath;
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

    if ((msg.photo?.length || msg.voice || msg.audio) && this.handlers.onMedia) {
      const isVoice = Boolean(msg.voice || msg.audio);
      const fileObj = isVoice ? (msg.voice || msg.audio) : msg.photo[msg.photo.length - 1];
      const mimeType = isVoice ? (fileObj.mime_type || 'audio/ogg') : 'image/jpeg';
      const ext = isVoice ? 'ogg' : 'jpg';
      const mediaPath = await this.downloadFile(fileObj.file_id, ext);
      await this.handlers.onMedia({ mediaPath, mimeType, caption: String(msg.caption || '').trim() });
      return;
    }

    const text = String(msg.text || '').trim();
    if (!text) return;

    if (this.awaitingTextQid && !text.startsWith('/')) {
      const qid = this.awaitingTextQid;
      this.awaitingTextQid = null;
      const pending = this.pendingChoices.get(qid);
      if (pending) {
        this.pendingChoices.delete(qid);
        pending.resolve(text);
        return;
      }
    }

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
