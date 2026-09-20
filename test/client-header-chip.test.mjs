import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const SLOT = 'conversation.session.header.utilities';
const NS = 'dsh-key-rotation';

// Execute the shipped client bundle and capture its registered component rather
// than copying the implementation. This small hook driver only exercises render
// and click transitions; it is not a browser/React lifecycle emulator.
function loadChip(snapshot = null) {
  let plugin;
  let registration;
  let dictionaries;
  let cursor = 0;
  const state = [];
  const React = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (next) => {
        state[index] = typeof next === 'function' ? next(state[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current: initial };
      return state[index];
    },
    useEffect() {},
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(definition) {
      plugin = definition.factory((name) => {
        if (name === 'react') return React;
        throw new Error(`Optional module unavailable: ${name}`);
      });
    } } },
    console,
  }, { filename: 'lib/client.js' });
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register(namespace, values) {
      assert.equal(namespace, NS);
      dictionaries = values;
    } },
    slots: {
      inject: (_name, fn) => fn(),
      register(options, component) {
        if (options.name === SLOT) registration = { options, component };
      },
    },
  });
  assert.ok(registration, 'the header component must be registered');
  // Effects are deliberately not run here. Seed the health hook with a fixture
  // instead of polling the host or contacting any provider.
  state[0] = snapshot;
  return {
    options: registration.options,
    dictionaries,
    render(props) {
      cursor = 0;
      return registration.component(props);
    },
  };
}

function nodes(tree, className) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, className));
  if (!tree || typeof tree !== 'object') return [];
  return [
    ...(tree.props.className === className ? [tree] : []),
    ...nodes(tree.children, className),
  ];
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || tree === false) return '';
  return typeof tree === 'object' ? text(tree.children) : String(tree);
}

const healthyPool = { pools: { example: { total: 51, healthy: 51, exhausted: false } } };

function toggle(chip, props) {
  const before = chip.render(props);
  nodes(before, 'krot-header-chip')[0].props.onClick();
  return chip.render(props);
}

test('header slot opts into the plugin translation namespace', () => {
  assert.equal(loadChip().options.locale, NS);
});

test('51/51 chip survives its first click and repeated open/close transitions', () => {
  const chip = loadChip(healthyPool);
  assert.match(text(chip.render()), /51\/51 rot/);
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = toggle(chip);
    assert.equal(nodes(open, 'krot-header-chip').length, 1);
    assert.equal(nodes(open, 'krot-popover').length, 1);
    assert.equal(text(nodes(open, 'krot-pop-title')[0]), 'Key rotation pools');
    assert.equal(text(nodes(open, 'krot-pop-count')[0]), '51/51');
    assert.equal(nodes(toggle(chip), 'krot-popover').length, 0);
  }
});

test('opening before health data arrives uses the English empty state', () => {
  const chip = loadChip();
  const open = toggle(chip);
  assert.match(text(open), /No active pools/);
  assert.equal(nodes(open, 'krot-header-chip')[0].props.title, 'Key Rotation');
});

test('tooltip, popover title and empty state use the host Chinese translator', () => {
  const chip = loadChip({ pools: {} });
  const props = { t: (key) => chip.dictionaries.zh[key] ?? key };
  const open = toggle(chip, props);
  assert.equal(nodes(open, 'krot-header-chip')[0].props.title, '密钥轮换');
  assert.equal(text(nodes(open, 'krot-pop-title')[0]), '密钥轮换池');
  assert.match(text(open), /无活跃密钥池/);
});

for (const [name, props] of [
  ['missing props', undefined],
  ['missing translator', {}],
  ['non-function translator', { t: 'not a function' }],
  ['untranslated keys', { t: (key) => key }],
  ['empty translations', { t: () => '' }],
]) {
  test(`opening falls back to English with ${name}`, () => {
    const open = toggle(loadChip(), props);
    assert.equal(text(nodes(open, 'krot-pop-title')[0]), 'Key rotation pools');
    assert.match(text(open), /No active pools/);
  });
}

test('an exhausted pool still renders its counts after opening', () => {
  const chip = loadChip({ pools: { example: { total: 50, healthy: 0, exhausted: true } } });
  const open = toggle(chip);
  assert.match(text(open), /0\/50 rot/);
  assert.equal(text(nodes(open, 'krot-pop-count')[0]), '0/50');
  assert.match(nodes(open, 'krot-pop-count')[0].props.style.color, /state-error-primary/);
});
