import React, { useState } from 'react';
import { ChatComposer, ConversationMessages, useConversation } from './chat';
import { api, dateTime, Empty } from './shared';

function Thread({ id, onReply }) {
  const { data, error, accept } = useConversation('plants/conversations/' + id);
  async function send(body) {
    accept(await api('plants/conversations/' + id, { method: 'POST', body }));
    void onReply();
  }
  return (
    <section className="panel chat-panel" aria-label="Переписка с пользователем">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data ? (
        <>
          <div className="chat-heading">
            <h2>{data.customer.name}</h2>
            <small>@{data.customer.username}</small>
          </div>
          <ConversationMessages items={data.items} own="admin" />
          <ChatComposer send={send} label="Ваш ответ пользователю" limit={4000} />
        </>
      ) : (
        <Empty>Загрузка переписки…</Empty>
      )}
    </section>
  );
}

export function CustomerQuestions() {
  const [selected, select] = useState(null);
  const { data, error, accept } = useConversation('plants/conversations');
  async function refreshList() {
    try {
      accept(await api('plants/conversations'));
    } catch {
      // The scheduled refresh reports any continuing connection error.
    }
  }
  const items = data?.items || [];
  return (
    <>
      <div className="page-heading">
        <h1>Вопросы пользователей</h1>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-inbox">
        <section className="panel inbox-list" aria-label="Список обращений">
          {items.map((item) => (
            <button key={item.id} aria-pressed={item.id === selected} onClick={() => select(item.id)}>
              <span className="inbox-row">
                <strong>{item.name}</strong>
                <small>{dateTime(item.updated_at)}</small>
              </span>
              <span className={'chat-state ' + item.state}>
                {item.state === 'pending' ? 'Ждёт ответа' : 'Отвечено'}
              </span>
              <span className="inbox-preview">{item.latest}</span>
            </button>
          ))}
          {items.length === 0 && <Empty>{data ? 'Обращений пока нет.' : 'Загрузка обращений…'}</Empty>}
        </section>
        {selected ? (
          <Thread key={selected} id={selected} onReply={refreshList} />
        ) : (
          <section className="panel">
            <Empty>Выберите обращение, чтобы открыть переписку.</Empty>
          </section>
        )}
      </div>
    </>
  );
}
