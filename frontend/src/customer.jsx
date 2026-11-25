import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Leaf, LogOut, MessageCircle, Minus, Plus, ShoppingBasket, Trash2 } from 'lucide-react';
import { ChatComposer, ConversationMessages, useConversation } from './chat';
import { PlantIcon, SearchBox } from './components';
import { api, Brand, Empty, num } from './shared';

const sections = [
  ['catalog', 'Каталог', Leaf],
  ['cart', 'Корзина', ShoppingBasket],
  ['chat', 'Консультант', MessageCircle],
];
const price = (amount) =>
  amount == null
    ? 'Цена уточняется'
    : new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: 2,
      }).format(amount);

function Catalog({ items, cart, busy, onQuantity, onChat }) {
  const [query, setQuery] = useState('');
  const search = query.toLowerCase().trim();
  const filtered = items.filter((item) =>
    [item.name, item.scientific_name, item.category].some((value) => value?.toLowerCase().includes(search)),
  );
  return (
    <>
      <section className="hero shop-hero">
        <div className="hero-copy">
          <h1>Растения питомника</h1>
          <p>Сорта и виды, готовые к продаже</p>
          <button className="btn hero-btn" onClick={onChat}>
            <MessageCircle size={17} /> Помогите выбрать
          </button>
        </div>
      </section>
      <div className="shop-section-heading">
        <h2>В наличии</h2>
        <SearchBox value={query} onChange={setQuery} placeholder="Найти растение" />
      </div>
      <div className="product-grid">
        {filtered.map((item) => {
          const count = cart.find((row) => row.plant_id === item.id)?.quantity || 0;
          return (
            <article className="panel shop-product" key={item.id}>
              <div className="shop-product-art">
                <PlantIcon id={item.id} />
              </div>
              <div className="shop-product-body">
                {item.category && <span className="shop-category">{item.category}</span>}
                <h3>{item.name}</h3>
                {item.scientific_name && <p className="shop-scientific">{item.scientific_name}</p>}
                <p className="shop-stock">В наличии {num(item.available)} шт.</p>
                <div className="shop-product-action">
                  <strong>{price(item.price_rub)}</strong>
                  <button
                    className="btn primary"
                    disabled={busy || count >= item.available}
                    onClick={() => onQuantity(item.id, count + 1)}
                  >
                    <Plus size={16} /> {count >= item.available ? 'Весь остаток в корзине' : 'В корзину'}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {filtered.length === 0 && <Empty>Растения не найдены.</Empty>}
    </>
  );
}

function Cart({ items, busy, onQuantity, browse }) {
  const priced = items.filter((item) => item.price_rub !== null && item.quantity <= item.available);
  const total = priced.reduce((sum, item) => sum + item.quantity * item.price_rub, 0);
  return (
    <>
      <div className="page-heading">
        <h1>Корзина</h1>
      </div>
      <section className="panel">
        {items.length === 0 && (
          <div className="shop-empty">
            <p>Корзина пока пуста.</p>
            <button className="btn primary" onClick={browse}>
              Открыть каталог
            </button>
          </div>
        )}
        {items.map((item) => (
          <article className="cart-row" key={item.plant_id}>
            <PlantIcon id={item.plant_id} />
            <div className="cart-label">
              <h3>{item.name}</h3>
              <p>{price(item.price_rub)}</p>
              {item.quantity > item.available && (
                <small className="cart-warning">
                  {item.available
                    ? 'Сейчас доступно ' + num(item.available) + ' шт.'
                    : 'Сейчас нет в наличии'}
                </small>
              )}
            </div>
            <div className="cart-quantity">
              <button
                className="iconbtn"
                aria-label={'Уменьшить количество · ' + item.name}
                disabled={busy || item.quantity <= 1}
                onClick={() => onQuantity(item.plant_id, Math.min(item.available, item.quantity - 1))}
              >
                <Minus size={16} />
              </button>
              <b>{num(item.quantity)}</b>
              <button
                className="iconbtn"
                aria-label={'Увеличить количество · ' + item.name}
                disabled={busy || item.quantity >= item.available}
                onClick={() => onQuantity(item.plant_id, item.quantity + 1)}
              >
                <Plus size={16} />
              </button>
              <button
                className="iconbtn"
                aria-label={'Удалить · ' + item.name}
                disabled={busy}
                onClick={() => onQuantity(item.plant_id, 0)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
        {priced.length > 0 && (
          <p className="cart-total">
            Стоимость доступных позиций с указанной ценой <b>{price(total)}</b>
          </p>
        )}
      </section>
    </>
  );
}

const suggestions = [
  { title: 'Подобрать растение', prompt: 'Подберите растение для полутени.' },
  { title: 'Спросить об уходе', prompt: 'Как поливать гортензию?' },
  { title: 'Связаться с человеком', prompt: 'Позовите администратора, пожалуйста.' },
];

function CustomerChat({ onCartChange }) {
  const { data, error, accept } = useConversation('shop/conversation');
  const stateLabel = {
    assistant: 'Консультант',
    pending: 'Ждём ответа администратора',
    answered: 'В чате администратор',
  };
  async function send(body) {
    const result = await api('shop/conversation', { method: 'POST', body });
    accept(result);
    void onCartChange();
  }
  return (
    <>
      <div className="page-heading">
        <h1>Консультант</h1>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel chat-panel" aria-label="Чат с питомником">
        {data && (
          <div className="chat-heading">
            <span className={'chat-state ' + data.state}>{stateLabel[data.state]}</span>
          </div>
        )}
        <ConversationMessages items={data?.items || []} own="customer">
          <Empty>
            {data
              ? 'Спросите об уходе или расскажите, для какого места выбираете растение.'
              : 'Загрузка переписки…'}
          </Empty>
        </ConversationMessages>
        {data && (
          <ChatComposer
            send={send}
            label="Ваше сообщение"
            suggestions={data.state === 'assistant' ? suggestions : []}
          />
        )}
      </section>
    </>
  );
}

function CustomerApp() {
  const [user, setUser] = useState(null);
  const [section, select] = useState('catalog');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const updating = useRef(false);
  const catalog = useConversation('shop/catalog', 20_000);
  const cart = useConversation('shop/cart', 10_000);
  useEffect(() => {
    api('shop/session')
      .then(setUser)
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function quantity(plant_id, count) {
    if (updating.current) return;
    updating.current = true;
    setBusy(true);
    setError('');
    try {
      const previous_quantity = cart.data?.items.find((item) => item.plant_id === plant_id)?.quantity || 0;
      cart.accept(
        await api('shop/cart', { method: 'PUT', body: { plant_id, quantity: count, previous_quantity } }),
      );
      setNotice(section === 'catalog' ? 'Добавлено в корзину.' : 'Корзина обновлена.');
    } catch (err) {
      setError(err.message);
      void refreshCart();
    } finally {
      updating.current = false;
      setBusy(false);
    }
  }
  async function refreshCart() {
    try {
      cart.accept(await api('shop/cart'));
    } catch (err) {
      setError(err.message);
    }
  }
  async function logout() {
    try {
      await api('logout', { method: 'POST' });
      location.replace('/');
    } catch (err) {
      setError(err.message);
    }
  }
  const lines = cart.data?.items || [];
  const cartCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const problem = error || (section === 'catalog' ? catalog.error : cart.error);
  return (
    <>
      <header className="shop-header">
        <div className="shop-bar">
          <Brand />
          <div className="shop-account">
            {user && <span>{user.name}</span>}
            <button className="btn" onClick={logout}>
              <LogOut size={16} /> Выйти
            </button>
          </div>
        </div>
        <nav className="shop-nav" aria-label="Разделы магазина">
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              aria-pressed={section === id}
              onClick={() => {
                select(id);
                setError('');
              }}
            >
              <Icon size={18} /> {label}
              {id === 'cart' && cartCount > 0 && <span>{num(cartCount)}</span>}
            </button>
          ))}
        </nav>
      </header>
      <main className="main shop-main">
        {problem && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
        {section === 'catalog' &&
          (catalog.data ? (
            <Catalog
              items={catalog.data.items}
              cart={lines}
              onQuantity={quantity}
              busy={busy || !cart.data}
              onChat={() => select('chat')}
            />
          ) : (
            <Empty>Загрузка каталога…</Empty>
          ))}
        {section === 'cart' &&
          (cart.data ? (
            <Cart items={lines} busy={busy} onQuantity={quantity} browse={() => select('catalog')} />
          ) : (
            <Empty>Загрузка корзины…</Empty>
          ))}
        {section === 'chat' && <CustomerChat onCartChange={refreshCart} />}
      </main>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(<CustomerApp />);
