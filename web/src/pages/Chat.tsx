import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Copy, Download, Paperclip, Send, Trash2, X } from 'lucide-react';
import { api, download, upload } from '../api';
import { errorText, t } from '../i18n';
import { dateTime, relativeTime } from '../domain';
import { routeHash } from '../routes';
import { Empty, Panel } from '../ui';
import type { Ctx } from './shared';

interface Channel {
  id: string;
  label: string;
  kind: 'general' | 'group' | 'node';
}
interface Attachment {
  id: string;
  name: string;
  size: number;
}
interface ChatMessage {
  id: number;
  channel: string;
  at: string;
  author: string;
  body: string;
  attachment: Attachment | null;
}

const BASE = '/plugins/chat';
const NAME_KEY = 'computedeck.chatName';

function savedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string) {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    /* A private window may block storage; the name then lasts for this page only. */
  }
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Notes and small files for everyone who opens this ComputeDeck, by channel. */
export function ChatPage({ ctx }: { ctx: Ctx }) {
  const tool = ctx.tools.find((item) => item.id === 'chat');
  if (!tool?.enabled)
    return (
      <Panel>
        <Empty
          title={t('chat.off')}
          text={t('chat.offHint')}
          action={
            <a className="button primary" href={routeHash('toolbox')}>
              {t('nav.toolbox')}
            </a>
          }
        />
      </Panel>
    );
  return <ChatContent ctx={ctx} />;
}

function ChatContent({ ctx }: { ctx: Ctx }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState('general');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [name, setName] = useState(savedName);
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(25);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cursor = useRef({ channel: 'general', lastId: 0 });
  const pollId = useRef(0);

  useEffect(() => {
    api<{ channels: Channel[]; max_file_mb: number }>(BASE)
      .then((data) => {
        setChannels(data.channels);
        setLimit(data.max_file_mb);
      })
      .catch((reason) => setError(errorText(reason, 'error.service')));
  }, []);

  const poll = useCallback(async () => {
    // A send started in another channel must not restart that channel's poll.
    if (cursor.current.channel !== channel) return;
    const requestId = pollId.current;
    const rows = await api<ChatMessage[]>(
      `${BASE}/messages?channel=${encodeURIComponent(channel)}&after=${cursor.current.lastId}`,
    );
    if (requestId !== pollId.current) return;
    // Overlapping polls can contain the same messages; keep each one only once.
    const unseen = rows.filter((row) => row.id > cursor.current.lastId);
    if (unseen.length) {
      cursor.current.lastId = unseen[unseen.length - 1].id;
      setMessages((current) => [...current, ...unseen]);
    }
  }, [channel]);

  useEffect(() => {
    let active = true;
    void poll().catch((reason) => {
      if (active) setError(errorText(reason, 'error.service'));
    });
    const timer = window.setInterval(() => void poll().catch(() => undefined), 4000);
    return () => {
      active = false;
      clearInterval(timer);
      pollId.current += 1;
    };
  }, [poll]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (busy || !name.trim() || (!draft.trim() && !file)) return;
    setBusy(true);
    setError(null);
    try {
      const attachment = file
        ? await upload<Attachment>(
            `${BASE}/attachments?name=${encodeURIComponent(file.name)}`,
            file,
          )
        : null;
      await api(`${BASE}/messages`, {
        channel,
        author: name.trim(),
        body: draft,
        attachment: attachment?.id ?? null,
      });
      setDraft('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await poll();
    } catch (reason) {
      setError(errorText(reason, 'error.save'));
    } finally {
      setBusy(false);
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function save(attachment: Attachment) {
    try {
      const blob = await download(`${BASE}/attachments/${attachment.id}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.service'), 'error');
    }
  }

  async function remove(item: ChatMessage) {
    if (!window.confirm(t('chat.removeConfirm'))) return;
    try {
      await api(`${BASE}/messages/${item.id}`, {}, 'DELETE');
      setMessages((current) => current.filter((row) => row.id !== item.id));
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.save'), 'error');
    }
  }

  const current = channels.find((item) => item.id === channel);
  return (
    <div className="chat">
      <nav className="chat-channels" aria-label={t('chat.channels')}>
        {channels.map((item) => (
          <button
            key={item.id}
            className={item.id === channel ? 'active' : ''}
            aria-current={item.id === channel ? 'true' : undefined}
            onClick={() => {
              if (item.id === channel) return;
              pollId.current += 1;
              cursor.current = { channel: item.id, lastId: 0 };
              setChannel(item.id);
              setMessages([]);
              setError(null);
            }}
          >
            {item.kind === 'general' ? t('chat.general') : item.label}
            {item.kind === 'node' && <small>{t('chat.machine')}</small>}
          </button>
        ))}
      </nav>
      <Panel
        className="chat-panel"
        title={current?.kind === 'general' ? t('chat.general') : (current?.label ?? channel)}
      >
        <div className="chat-messages" ref={listRef}>
          {messages.length ? (
            messages.map((item) => (
              <article key={item.id} className="chat-message">
                <header>
                  <strong>{item.author}</strong>
                  <time dateTime={item.at} title={dateTime(item.at)}>
                    {relativeTime(item.at)}
                  </time>
                  <span className="grow" />
                  {item.body && (
                    <button
                      className="icon-button"
                      aria-label={t('common.copy')}
                      onClick={() => void ctx.copy(item.body)}
                    >
                      <Copy size={12} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={t('common.remove')}
                    onClick={() => void remove(item)}
                  >
                    <Trash2 size={12} />
                  </button>
                </header>
                {item.body && <p>{item.body}</p>}
                {item.attachment && (
                  <button className="chat-file" onClick={() => void save(item.attachment!)}>
                    <Download size={13} /> {item.attachment.name}{' '}
                    <small>{size(item.attachment.size)}</small>
                  </button>
                )}
              </article>
            ))
          ) : (
            <p className="panel-note">{t('chat.empty')}</p>
          )}
        </div>
        <form className="chat-compose" onSubmit={(event) => void send(event)}>
          <label className="chat-name">
            {t('chat.postingAs')}
            <input
              value={name}
              maxLength={40}
              placeholder={t('chat.namePlaceholder')}
              onChange={(event) => {
                setName(event.target.value);
                saveName(event.target.value.trim());
              }}
            />
          </label>
          <textarea
            value={draft}
            rows={2}
            placeholder={t('chat.placeholder', { name: name || '…' })}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKey}
          />
          <div className="chat-actions">
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                if (chosen && chosen.size > limit * 1024 * 1024) {
                  setError(t('chat.tooLarge', { limit }));
                  return;
                }
                setFile(chosen);
              }}
            />
            <button type="button" className="button small" onClick={() => fileRef.current?.click()}>
              <Paperclip size={13} /> {t('chat.attach')}
            </button>
            {file && (
              <span className="chat-chosen">
                {file.name} <small>{size(file.size)}</small>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('common.remove')}
                  onClick={() => setFile(null)}
                >
                  <X size={12} />
                </button>
              </span>
            )}
            <span className="grow" />
            {error && <span className="red-text">{error}</span>}
            <button
              type="submit"
              className="button primary small"
              disabled={busy || !name.trim() || (!draft.trim() && !file)}
            >
              <Send size={13} /> {t('chat.send')}
            </button>
          </div>
          <small className="chat-note">{t('chat.note')}</small>
        </form>
      </Panel>
    </div>
  );
}
