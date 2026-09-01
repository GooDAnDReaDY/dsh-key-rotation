# Self-healing cooldown — Design

Date: 2026-08-27
Plugin: `@goodandready/dsh-key-rotation`
Refs: issue #TBD (создам при коммите)

## Что

Автоматический сброс cooldown-флага для ключа, который долго не
использовался после пометки failed. Сейчас ключ в cooldown висит до
ручного `/reset` или до следующей попытки ротации — если провайдер
реально восстановился, ключ сам не «проснётся».

## Почему

Cooldown в pool.state.failedUntil:Map<ref, epochMs>. Помечается при
`markFailed()`. Снимается только через `resetKey()` (POST /reset) или
когда `failedUntil <= now`. Если ключ провалидировал и больше никто
его не пытается использовать (например, у плагина только один пул,
или другие ключи в пуле его обходят через weighted/healthy),
cooldown остаётся, хотя ключ уже мог восстановиться.

## Решение

Tick каждые 60s в `apply()` пробегает по всем pool.state.failedUntil.
Ключ снимается с cooldown автоматически если:

```
(now - lastUsed.get(ref) >= selfHealIdleMs)  // ключ не использовался долго
  AND
failedUntil.get(ref) <= now                 // cooldown уже истёк
  AND
lastUsed.get(ref) !== undefined             // ключ был в работе хотя бы раз
```

При снятии:
- удаляем запись из `failedUntil`
- пушим событие `type='heal'` в `pool.state.events`
- pushEvent pool state cleanup

НЕ снимаем если:
- `lastUsed` неизвестен (ключ ни разу не использовали — нет сигнала)
- `failedUntil > now` (cooldown ещё активен)
- `now - lastUsed < selfHealIdleMs` (ключ активно используется — ротация его сама дёрнет)

## API: новые поля Config

```js
selfHealCooldown: Schema.boolean().default(true),
selfHealIdleMs: Schema.number().default(3600000),  // 1h
```

## Файлы

| path | change |
|------|--------|
| `host/lib/index.js` | Config schema +2 поля; в apply() запустить `setInterval` 60s с `healIdleCooldowns()` |
| `host/lib/heal.js` | new: `healIdleCooldowns(pools, idleMs)` — чистая функция, мутирует state, возвращает массив событий |
| `test/heal.test.mjs` | new: unit-тесты |

## YAGNI (не делаем)

- ❌ HTTP-probe для подтверждения живости ключа (дорого; танк
  self-heal уже после 1h неактивности → сигнал достаточный)
- ❌ Метрика «сколько ключей healed за час» (в events уже есть
  `type='heal'`, посчитают владельцы по логам)
- ❌ Per-pool override `selfHealIdleMs` (одно глобальное достаточно)
- ❌ Сложная стратегия: учитывать healthScore при heal (YAGNI)

## Скилл-комплаенс

- ✅ no-force, Gitea API merge
- ✅ tests: unit покрытие основной функции + edge cases
- ✅ Conventional commit
- ✅ YAGNI

## Acceptance

- 136+N тестов проходят
- `node --check` ok
- Manual: `markFailed(ref, 1000)` → tick → lastUsed=undefined → НЕ снимается (правильно)
- Manual: `markFailed(ref, 1000)` → use ref → wait 2h → tick → снимается, событие heal
- Manual: Config `selfHealCooldown: false` → tick не работает
