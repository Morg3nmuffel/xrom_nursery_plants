import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Eye, EyeOff, LockKeyhole, UserRound, Leaf } from 'lucide-react';
import { Brand, api } from './shared';

function Login() {
  const [role, setRole] = useState('admin');
  const [registering, setRegistering] = useState(false);
  const [shown, show] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      const endpoint = {
        admin: 'login',
        employee: 'employee/login',
        customer: registering ? 'shop/register' : 'shop/login',
      }[role];
      await api(endpoint, {
        method: 'POST',
        body: {
          username: form.get('username').trim(),
          password: form.get('password'),
          name: form.get('name') || undefined,
        },
      });
      location.replace('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-scene">
        <Brand />
        <div className="scene-title">
          <span className="scene-mark">
            <Leaf size={17} /> XROM GROUP
          </span>
          <h2>
            Питомник
            <br />
            растений
          </h2>
        </div>
      </section>
      <section className="login-side">
        <div className="login-box">
          <span className="lock-icon">
            <LockKeyhole size={24} />
          </span>
          <h1>{registering ? 'Регистрация' : 'Вход в питомник'}</h1>
          <form onSubmit={submit}>
            <fieldset className="login-roles" disabled={busy}>
              <legend>Тип учётной записи</legend>
              {[
                ['admin', 'Администратор'],
                ['employee', 'Сотрудник'],
                ['customer', 'Пользователь'],
              ].map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="role"
                    checked={role === value}
                    onChange={() => {
                      setRole(value);
                      setRegistering(false);
                      setError('');
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            {role === 'employee' && (
              <p className="login-hint">Введите логин и пароль, выданные администратором.</p>
            )}
            {registering && (
              <label>
                Имя
                <input
                  name="name"
                  className="registration-name"
                  autoComplete="given-name"
                  maxLength={100}
                  required
                />
              </label>
            )}
            <label>
              Логин
              <div className="input-icon">
                <UserRound size={17} />
                <input
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  required
                  autoFocus
                  maxLength={registering ? 40 : 160}
                  minLength={registering ? 3 : undefined}
                  pattern={registering ? '[a-zA-Z0-9_.\\-]{3,40}' : undefined}
                  title={registering ? 'Латинские буквы, цифры, точка, дефис или подчёркивание' : undefined}
                />
              </div>
            </label>
            <div>
              <label htmlFor="login-password">Пароль</label>
              <div className="input-icon">
                <LockKeyhole size={17} />
                <input
                  id="login-password"
                  name="password"
                  type={shown ? 'text' : 'password'}
                  autoComplete={registering ? 'new-password' : 'current-password'}
                  minLength={registering ? 8 : undefined}
                  maxLength={registering ? 256 : undefined}
                  required
                />
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'}
                  onClick={() => show(!shown)}
                >
                  {shown ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="btn primary wide" disabled={busy}>
              {busy ? 'Подождите…' : registering ? 'Зарегистрироваться' : 'Войти'}
            </button>
            {role === 'customer' && (
              <button
                className="text-button login-switch"
                type="button"
                disabled={busy}
                onClick={() => {
                  setRegistering(!registering);
                  setError('');
                }}
              >
                {registering ? 'У меня уже есть аккаунт' : 'Создать аккаунт'}
              </button>
            )}
          </form>
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')).render(<Login />);
