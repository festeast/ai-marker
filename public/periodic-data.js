// Данные таблицы Менделеева для инструмента на экзамене (exam-tools.js).
// Элементы по порядку номеров, строки через пробел. Масса в квадратных скобках — самый устойчивый изотоп.
const PERIODIC = {};
PERIODIC.symbols = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr '
  + 'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu '
  + 'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr '
  + 'Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');
PERIODIC.masses = ('1.008 4.0026 6.94 9.0122 10.81 12.011 14.007 15.999 18.998 20.180 22.990 24.305 26.982 28.085 30.974 32.06 35.45 39.948 '
  + '39.098 40.078 44.956 47.867 50.942 51.996 54.938 55.845 58.933 58.693 63.546 65.38 69.723 72.630 74.922 78.971 79.904 83.798 '
  + '85.468 87.62 88.906 91.224 92.906 95.95 [98] 101.07 102.91 106.42 107.87 112.41 114.82 118.71 121.76 127.60 126.90 131.29 '
  + '132.91 137.33 138.91 140.12 140.91 144.24 [145] 150.36 151.96 157.25 158.93 162.50 164.93 167.26 168.93 173.05 174.97 '
  + '178.49 180.95 183.84 186.21 190.23 192.22 195.08 196.97 200.59 204.38 207.2 208.98 [209] [210] [222] '
  + '[223] [226] [227] 232.04 231.04 238.03 [237] [244] [243] [247] [247] [251] [252] [257] [258] [259] [266] '
  + '[267] [268] [269] [270] [269] [278] [281] [282] [285] [286] [289] [290] [293] [294] [294]').split(' ');
// Электроотрицательность по Полингу; «-» — нет данных.
PERIODIC.eneg = ('2.20 - 0.98 1.57 2.04 2.55 3.04 3.44 3.98 - 0.93 1.31 1.61 1.90 2.19 2.58 3.16 - '
  + '0.82 1.00 1.36 1.54 1.63 1.66 1.55 1.83 1.88 1.91 1.90 1.65 1.81 2.01 2.18 2.55 2.96 3.00 '
  + '0.82 0.95 1.22 1.33 1.6 2.16 1.9 2.2 2.28 2.20 1.93 1.69 1.78 1.96 2.05 2.1 2.66 2.6 '
  + '0.79 0.89 1.10 1.12 1.13 1.14 - 1.17 - 1.20 - 1.22 1.23 1.24 1.25 - 1.27 '
  + '1.3 1.5 2.36 1.9 2.2 2.20 2.28 2.54 2.00 1.62 2.33 2.02 2.0 2.2 - '
  + '0.7 0.9 1.1 1.3 1.5 1.38 1.36 1.28 1.3 1.3 1.3 1.3 1.3 1.3 1.3 1.3 - '
  + '- - - - - - - - - - - - - - -').split(' ');
PERIODIC.names = {};
PERIODIC.names.ru = ('Водород Гелий Литий Бериллий Бор Углерод Азот Кислород Фтор Неон Натрий Магний Алюминий Кремний Фосфор Сера Хлор Аргон '
  + 'Калий Кальций Скандий Титан Ванадий Хром Марганец Железо Кобальт Никель Медь Цинк Галлий Германий Мышьяк Селен Бром Криптон '
  + 'Рубидий Стронций Иттрий Цирконий Ниобий Молибден Технеций Рутений Родий Палладий Серебро Кадмий Индий Олово Сурьма Теллур Иод Ксенон '
  + 'Цезий Барий Лантан Церий Празеодим Неодим Прометий Самарий Европий Гадолиний Тербий Диспрозий Гольмий Эрбий Тулий Иттербий Лютеций '
  + 'Гафний Тантал Вольфрам Рений Осмий Иридий Платина Золото Ртуть Таллий Свинец Висмут Полоний Астат Радон '
  + 'Франций Радий Актиний Торий Протактиний Уран Нептуний Плутоний Америций Кюрий Берклий Калифорний Эйнштейний Фермий Менделевий Нобелий Лоуренсий '
  + 'Резерфордий Дубний Сиборгий Борий Хассий Мейтнерий Дармштадтий Рентгений Коперниций Нихоний Флеровий Московий Ливерморий Теннессин Оганесон').split(' ');
// Английские названия и электронные конфигурации — из PubChem (пакет periodic-table-data, MIT).
PERIODIC.names.en = "Hydrogen Helium Lithium Beryllium Boron Carbon Nitrogen Oxygen Fluorine Neon Sodium Magnesium Aluminum Silicon Phosphorus Sulfur Chlorine Argon Potassium Calcium Scandium Titanium Vanadium Chromium Manganese Iron Cobalt Nickel Copper Zinc Gallium Germanium Arsenic Selenium Bromine Krypton Rubidium Strontium Yttrium Zirconium Niobium Molybdenum Technetium Ruthenium Rhodium Palladium Silver Cadmium Indium Tin Antimony Tellurium Iodine Xenon Cesium Barium Lanthanum Cerium Praseodymium Neodymium Promethium Samarium Europium Gadolinium Terbium Dysprosium Holmium Erbium Thulium Ytterbium Lutetium Hafnium Tantalum Tungsten Rhenium Osmium Iridium Platinum Gold Mercury Thallium Lead Bismuth Polonium Astatine Radon Francium Radium Actinium Thorium Protactinium Uranium Neptunium Plutonium Americium Curium Berkelium Californium Einsteinium Fermium Mendelevium Nobelium Lawrencium Rutherfordium Dubnium Seaborgium Bohrium Hassium Meitnerium Darmstadtium Roentgenium Copernicium Nihonium Flerovium Moscovium Livermorium Tennessine Oganesson".split(' ');
PERIODIC.config = ["1s1", "1s2", "[He]2s1", "[He]2s2", "[He]2s2 2p1", "[He]2s2 2p2", "[He] 2s2 2p3", "[He]2s2 2p4", "[He]2s2 2p5", "[He]2s2 2p6", "[Ne]3s1", "[Ne]3s2", "[Ne]3s2 3p1", "[Ne]3s2 3p2", "[Ne]3s2 3p3", "[Ne]3s2 3p4", "[Ne]3s2 3p5", "[Ne]3s2 3p6", "[Ar]4s1", "[Ar]4s2", "[Ar]4s2 3d1", "[Ar]4s2 3d2", "[Ar]4s2 3d3", "[Ar]3d5 4s1", "[Ar]4s2 3d5", "[Ar]4s2 3d6", "[Ar]4s2 3d7", "[Ar]4s2 3d8", "[Ar]4s1 3d10", "[Ar]4s2 3d10", "[Ar]4s2 3d10 4p1", "[Ar]4s2 3d10 4p2", "[Ar]4s2 3d10 4p3", "[Ar]4s2 3d10 4p4", "[Ar]4s2 3d10 4p5", "[Ar]4s2 3d10 4p6", "[Kr]5s1", "[Kr]5s2", "[Kr]5s2 4d1", "[Kr]5s2 4d2", "[Kr]5s1 4d4", "[Kr]5s1 4d5", "[Kr]5s2 4d5", "[Kr]5s1 4d7", "[Kr]5s1 4d8", "[Kr]4d10", "[Kr]5s1 4d10", "[Kr]5s2 4d10", "[Kr]5s2 4d10 5p1", "[Kr]5s2 4d10 5p2", "[Kr]5s2 4d10 5p3", "[Kr]5s2 4d10 5p4", "[Kr]5s2 4d10 5p5", "[Kr]5s2 4d10 5p6", "[Xe]6s1", "[Xe]6s2", "[Xe]6s2 5d1", "[Xe]6s2 4f1 5d1", "[Xe]6s2 4f3", "[Xe]6s2 4f4", "[Xe]6s2 4f5", "[Xe]6s2 4f6", "[Xe]6s2 4f7", "[Xe]6s2 4f7 5d1", "[Xe]6s2 4f9", "[Xe]6s2 4f10", "[Xe]6s2 4f11", "[Xe]6s2 4f12", "[Xe]6s2 4f13", "[Xe]6s2 4f14", "[Xe]6s2 4f14 5d1", "[Xe]6s2 4f14 5d2", "[Xe]6s2 4f14 5d3", "[Xe]6s2 4f14 5d4", "[Xe]6s2 4f14 5d5", "[Xe]6s2 4f14 5d6", "[Xe]6s2 4f14 5d7", "[Xe]6s1 4f14 5d9", "[Xe]6s1 4f14 5d10", "[Xe]6s2 4f14 5d10", "[Xe]6s2 4f14 5d10 6p1", "[Xe]6s2 4f14 5d10 6p2", "[Xe]6s2 4f14 5d10 6p3", "[Xe]6s2 4f14 5d10 6p4", "[Xe]6s2 4f14 5d10 6p5", "[Xe]6s2 4f14 5d10 6p6", "[Rn]7s1", "[Rn]7s2", "[Rn]7s2 6d1", "[Rn]7s2 6d2", "[Rn]7s2 5f2 6d1", "[Rn]7s2 5f3 6d1", "[Rn]7s2 5f4 6d1", "[Rn]7s2 5f6", "[Rn]7s2 5f7", "[Rn]7s2 5f7 6d1", "[Rn]7s2 5f9", "[Rn]7s2 5f10", "[Rn]7s2 5f11", "[Rn] 5f12 7s2", "[Rn]7s2 5f13", "[Rn]7s2 5f14", "[Rn]7s2 5f14 6d1", "[Rn]7s2 5f14 6d2", "[Rn]7s2 5f14 6d3", "[Rn]7s2 5f14 6d4", "[Rn]7s2 5f14 6d5", "[Rn]7s2 5f14 6d6", "[Rn]7s2 5f14 6d7 (calculated)", "[Rn]7s2 5f14 6d8 (predicted)", "[Rn]7s2 5f14 6d9 (predicted)", "[Rn]7s2 5f14 6d10 (predicted)", "[Rn]5f14 6d10 7s2 7p1 (predicted)", "[Rn]7s2 7p2 5f14 6d10 (predicted)", "[Rn]7s2 7p3 5f14 6d10 (predicted)", "[Rn]7s2 7p4 5f14 6d10 (predicted)", "[Rn]7s2 7p5 5f14 6d10 (predicted)", "[Rn]7s2 7p6 5f14 6d10 (predicted)"];
// Казахские названия, которые отличаются от русских; остальные совпадают.
PERIODIC.kkNames = { H: 'Сутегі', C: 'Көміртек', O: 'Оттегі', S: 'Күкірт', Fe: 'Темір', Cu: 'Мыс', Zn: 'Мырыш',
  Ag: 'Күміс', Sn: 'Қалайы', Au: 'Алтын', Hg: 'Сынап', Pb: 'Қорғасын' };
PERIODIC.name = (z, lang) => {
  const i = z - 1;
  if (lang === 'kk') return PERIODIC.kkNames[PERIODIC.symbols[i]] || PERIODIC.names.ru[i];
  return (lang === 'ru' ? PERIODIC.names.ru : PERIODIC.names.en)[i];
};
