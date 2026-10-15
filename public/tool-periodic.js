// Таблица Менделеева для экзамена (данные в periodic-data.js). Подключается после exam-tools.js.
ExamTools.BUILD.periodic = function periodic() {
  const groupOf = (z) => {
    if (z === 1) return 'nonmetal';
    if ([3, 11, 19, 37, 55, 87].includes(z)) return 'alkali';
    if ([4, 12, 20, 38, 56, 88].includes(z)) return 'alkaline';
    if (z >= 57 && z <= 71) return 'lanthanide';
    if (z >= 89 && z <= 103) return 'actinide';
    if ([2, 10, 18, 36, 54, 86, 118].includes(z)) return 'noble';
    if ([9, 17, 35, 53, 85, 117].includes(z)) return 'halogen';
    if ([6, 7, 8, 15, 16, 34].includes(z)) return 'nonmetal';
    if ([5, 14, 32, 33, 51, 52].includes(z)) return 'metalloid';
    if ([13, 31, 49, 50, 81, 82, 83, 84, 113, 114, 115, 116].includes(z)) return 'post';
    return 'transition';
  };
  // Строка и столбец клетки; лантаноиды и актиноиды — отдельными строками 9 и 10.
  const place = (z) => {
    if (z === 1) return [1, 1];
    if (z === 2) return [1, 18];
    const starts = [[3, 2], [11, 3], [19, 4], [37, 5], [55, 6], [87, 7]];
    const [s, row] = starts.filter(([a]) => z >= a).pop();
    const k = z - s;
    if (row <= 3) return [row, k < 2 ? k + 1 : k + 11];
    if (row <= 5) return [row, k + 1];
    if (k < 2) return [row, k + 1];
    if (k <= 16) return [row + 3, k + 1]; // La–Lu, Ac–Lr
    return [row, k - 13];
  };

  const info = el('div', { class: 'pt-info', 'aria-live': 'polite' }, t('periodic_hint'));
  const grid = el('div', { class: 'pt-grid' });
  const show = (z) => {
    const i = z - 1;
    const mass = PERIODIC.masses[i], eneg = PERIODIC.eneg[i];
    info.replaceChildren(
      el('b', { class: 'pt-big' }, PERIODIC.symbols[i]), ' ',
      el('b', {}, PERIODIC.name(z, LANG)), el('span', { class: 'muted' }, ` (${PERIODIC.names.en[i]})`),
      el('br'),
      `${t('periodic_number')}: ${z} · ${t('periodic_mass')}: ${mass}`,
      eneg !== '-' ? ` · ${t('periodic_eneg')}: ${eneg}` : '',
      el('br'),
      `${t('periodic_config')}: ${PERIODIC.config[i]} · `, el('span', { class: 'muted' }, t('periodic_cat_' + groupOf(z))));
  };
  for (let z = 1; z <= 118; z++) {
    const [r, c] = place(z);
    grid.append(el('button', {
      type: 'button', class: 'pt-el pt-' + groupOf(z), style: `grid-row:${r};grid-column:${c}`,
      title: PERIODIC.name(z, LANG), onclick: () => show(z),
    }, el('span', { class: 'pt-z' }, String(z)), el('span', { class: 'pt-sym' }, PERIODIC.symbols[z - 1]),
       el('span', { class: 'pt-m' }, PERIODIC.masses[z - 1])));
  }
  grid.append(el('div', { class: 'pt-gap', style: 'grid-row:6;grid-column:3' }, '57–71'),
    el('div', { class: 'pt-gap', style: 'grid-row:7;grid-column:3' }, '89–103'),
    el('div', { style: 'grid-row:8;grid-column:1;height:8px' }));
  const legend = el('div', { class: 'pt-legend' },
    ['alkali', 'alkaline', 'transition', 'post', 'metalloid', 'nonmetal', 'halogen', 'noble', 'lanthanide', 'actinide']
      .map((k) => el('span', {}, el('i', { class: 'pt-' + k }), t('periodic_cat_' + k))));
  return { node: el('div', {}, info, el('div', { class: 'table-scroll' }, grid), legend) };
};
