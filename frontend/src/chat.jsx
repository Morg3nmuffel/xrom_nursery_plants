import React, { useEffect, useId, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { api, dateTime } from './shared';

const authorLabels = { customer: 'Пользователь', assistant: 'Консультант', admin: 'Администратор' };

export function useConversation(path, interval = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => {
    async function load() {
      const request = ++version.current;
      try {
        const result = await api(path);
        if (request === version.current) {
          setData(result);
          setError('');
        }
      } catch (err) {
        if (request === version.current) setError(err.message);
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, interval);
    return () => {
      ++version.current;
      clearInterval(timer);
    };
  }, [path, interval]);
  function accept(result) {
    ++version.current;
    setData(result);
    setError('');
  }
  return { data, error, accept };
}

export function ConversationMessages({ items, own, children }) {
  const scroller = useRef(null);
  useEffect(() => {
    const view = scroller.current;
    view.scrollTop = view.scrollHeight;
  }, [items.length]);
  return (
    <div className="chat-messages" ref={scroller} role="log" aria-label="Переписка" tabIndex={0}>
      {items.length === 0 && children}
      {items.map((message) => (
        <article key={message.id} className={'message ' + (message.author === own ? 'mine' : message.author)}>
          <div className="message-meta">
            <strong>{message.author === own ? 'Вы' : authorLabels[message.author]}</strong>
            <time dateTime={message.sent_at}>{dateTime(message.sent_at)}</time>
          </div>
          <p>{message.text}</p>
        </article>
      ))}
    </div>
  );
}

export function ChatComposer({ send, label, limit = 2000, suggestions = [] }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const requestId = useRef(null);
  const fieldId = useId();
  function edit(text) {
    requestId.current = null;
    setDraft(text);
  }
  async function submit(event) {
    event.preventDefault();
    if (pending.current || !draft.trim()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    requestId.current ??= crypto.randomUUID();
    try {
      await send({ text: draft.trim(), request_id: requestId.current });
      edit('');
    } catch (err) {
      setError(err.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="chat-compose" onSubmit={submit}>
      {suggestions.length > 0 && (
        <div className="chat-suggestions" aria-label="Подсказки">
          {suggestions.map(({ title, prompt }) => (
            <button type="button" className="btn" key={title} disabled={busy} onClick={() => edit(prompt)}>
              {title}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label htmlFor={fieldId}>{label}</label>
      <div className="chat-send">
        <textarea
          id={fieldId}
          rows={2}
          maxLength={limit}
          value={draft}
          disabled={busy}
          onChange={(event) => edit(event.target.value)}
          required
        />
        <button type="submit" className="btn primary" disabled={busy || !draft.trim()}>
          <Send size={16} /> {busy ? 'Отправляем…' : 'Отправить'}
        </button>
      </div>
    </form>
  );
}
