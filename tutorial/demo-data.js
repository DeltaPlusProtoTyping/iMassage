// Demo mode for tutorial screenshots: fake contacts and messages only; real data and events are cut off.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const SCENE = window.SCENE || 'main';
  const now = Date.now();
  const min = 60000;
  onMessages = () => {};
  notify = () => {};
  const P = (handle, name) => ({ handle, label: handle, name, first: name.split(' ')[0], photo: null, known: true });
  const people = {
    maya: P('+15550100', 'Maya Chen'), jordan: P('+15550101', 'Jordan Ellis'), dad: P('+15550102', 'Dad'),
    priya: P('+15550103', 'Priya Patel'), alex: P('+15550104', 'Alex Kim'), mom: P('+15550105', 'Mom'),
    sam: P('+15550106', 'Sam Rivera'), theo: P('+15550107', 'Theo Brooks'), nina: P('+15550108', 'Nina Alvarez'),
    lee: P('+15550109', 'Lee Park'),
  };
  let mid = 990000;
  const msg = (chat, who, text, ago, extra = {}) => {
    const p = who === 'me' ? null : people[who];
    return Object.assign({
      id: ++mid, guid: 'demo-' + mid, chat, date: now - ago * min, fromMe: who === 'me', handle: p ? p.handle : null,
      service: 'iMessage', text, sent: true, delivered: true, read: true, dateRead: now - (ago - 0.5) * min,
      dateDelivered: 0, error: 0, itemType: 0, sender: p && p.name, senderFirst: p && p.first, senderPhoto: null,
    }, extra);
  };
  const threads = {
    900001: [
      msg(900001, 'maya', 'are we still on for climbing tonight?', 52),
      msg(900001, 'me', 'yes! 7 at the gym?', 50),
      msg(900001, 'maya', "perfect. I'll bring the extra harness", 49),
      msg(900001, 'maya', 'also did you see the new route they set', 48),
      msg(900001, 'me', 'the overhang one?? I fell off it twice last week 😅', 46),
      msg(900001, 'maya', "lol that's the one. tonight's the night", 45),
      msg(900001, 'me', 'heading out in 10', 1, { read: false, dateRead: 0 }),
    ],
    900002: [msg(900002, 'jordan', 'Sending the deck over now', 90), msg(900002, 'me', 'Got it, looks great', 80)],
    900003: [msg(900003, 'mom', 'Dinner Sunday? Dad is making ribs', 130), msg(900003, 'dad', 'Bring the good hot sauce', 120)],
    900004: [msg(900004, 'dad', 'Call me when you get a sec', 200)],
    900005: [msg(900005, 'priya', 'Flight lands at 6:40', 300)],
    900006: [msg(900006, 'alex', 'haha classic', 400)],
    900007: [
      msg(900007, 'theo', 'hey is this still your number?', 1500, { service: 'SMS' }),
      msg(900007, 'me', 'Yep! Got a new phone', 1490, { service: 'SMS' }),
      msg(900007, 'theo', 'cool, saved it 👍', 1480, { service: 'SMS' }),
    ],
    900008: [msg(900008, 'sam', 'The package came today', 2000)],
    900009: [msg(900009, 'nina', 'See you at 9', 2900)],
    900010: [msg(900010, 'lee', 'Thanks again for the help!', 4400)],
  };
  const reactions = { 900001: [msg(900001, 'maya', '', 45.5, { reaction: { target: 'demo-990005', kind: 'laugh', remove: false } })] };
  const chat = (id, name, members, pin, extra = {}) => {
    const t = threads[id];
    const last = t[t.length - 1];
    return Object.assign({ id, guid: 'demo;' + id, name, group: members.length > 1, service: 'iMessage', identifier: members[0].handle,
      members, filtered: 0, lastDate: last.date, last, unread: [], pin }, extra);
  };
  const chats = [
    chat(900001, 'Maya Chen', [people.maya], 0),
    chat(900002, 'Jordan Ellis', [people.jordan], 1),
    chat(900003, 'Family', [people.mom, people.dad], 2, { unread: [threads[900003][1].id] }),
    chat(900004, 'Dad', [people.dad], 3),
    chat(900005, 'Priya Patel', [people.priya], 4),
    chat(900006, 'Alex Kim', [people.alex], 5),
    chat(900007, 'Theo Brooks', [people.theo], null, { service: 'SMS' }),
    chat(900008, 'Sam Rivera', [people.sam], null, { unread: [threads[900008][0].id] }),
    chat(900009, 'Nina Alvarez', [people.nina], null),
    chat(900010, 'Lee Park', [people.lee], null),
  ];
  api = async (path, opts = {}) => {
    if (path.startsWith('/api/chats?') || path === '/api/chats') return JSON.parse(JSON.stringify(chats));
    let m = path.match(/^\/api\/chats\/(\d+)\/messages/);
    if (m) return { messages: JSON.parse(JSON.stringify(threads[m[1]] || [])), reactions: JSON.parse(JSON.stringify(reactions[m[1]] || [])), more: false };
    if (path.startsWith('/api/search')) {
      const q = new URL(path, location.href).searchParams.get('q').toLowerCase();
      return [].concat(...Object.values(threads)).filter(x => x.text.toLowerCase().includes(q)).reverse();
    }
    if (path.startsWith('/api/scheduled')) return [];
    return opts.body ? { ok: true } : [];
  };
  S.drafts = new Map([[900005, 'Want me to pick you up?']]);
  S.chats = new Map();
  S.threads = new Map();
  S.current = null;
  S.booted = true;
  await refreshChats();
  const open = SCENE === 'sms' ? 900007 : 900001;
  await openChat(open);
  await wait(500);
  const row = guid => els.thread.querySelector(`[data-guid="${guid}"]`);
  const t = S.threads.get(open);
  if (SCENE === 'tapback') {
    openTapbackPicker(t.byGuid.get('demo-990006'), row('demo-990006'));
  } else if (SCENE === 'menu') {
    const r = row('demo-990007').querySelector('.bubble').getBoundingClientRect();
    messageMenu(t.byGuid.get('demo-990007'), row('demo-990007'), r.left - 150, r.top - 150);
  } else if (SCENE === 'edit') {
    startEdit(t.byGuid.get('demo-990007'));
    els.input.value = 'heading out in 5!';
    autosize(); updateSendState();
  } else if (SCENE === 'find') {
    openFind();
    els.findInput.value = 'harness';
    runFind();
    await wait(900);
  } else if (SCENE === 'later') {
    els.input.value = 'Happy birthday!! 🎂 have the best day';
    autosize(); updateSendState();
    await wait(300);
    const r = els.send.getBoundingClientRect();
    sendLaterMenu(r.left - 200, r.top - 150);
  }
  document.activeElement && document.activeElement.blur && SCENE !== 'edit' && SCENE !== 'find' && document.activeElement.blur();
})();
