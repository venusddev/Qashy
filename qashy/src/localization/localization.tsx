import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';

import { useFinanceState } from '@/providers/finance-provider';

export type AppLanguage = 'en' | 'he';

export const APP_LANGUAGE_OPTIONS = [
  { value: 'en-US', label: 'English' },
  { value: 'he-IL', label: 'Hebrew' },
] as const;

const HEBREW: Record<string, string> = {
  English: 'אנגלית', Hebrew: 'עברית',
  Overview: 'סקירה', Transactions: 'תנועות', Plan: 'תכנון', More: 'עוד',
  Transaction: 'תנועה', Budget: 'תקציב', Goal: 'יעד', Account: 'חשבון', Category: 'קטגוריה',
  'Recurring transaction': 'תנועה מחזורית', 'Exchange rate': 'שער חליפין', Appearance: 'מראה',
  'Import & export': 'ייבוא וייצוא',
  'Money, made calmer.': 'כסף, בצורה רגועה יותר.',
  'Qashy is a private, local-first place for everyday spending, flexible budgets, and goals.': 'Qashy הוא מקום פרטי ומקומי לניהול הוצאות יומיומיות, תקציבים גמישים ויעדים.',
  'Private by default': 'פרטי כברירת מחדל',
  'No account and no finance data leaves this device.': 'ללא חשבון, ושום מידע פיננסי לא יוצא מהמכשיר.',
  'Flexible, not fussy': 'גמיש, בלי טרחה',
  'Track the categories and time periods that fit your life.': 'עקבו אחר הקטגוריות ותקופות הזמן שמתאימות לחיים שלכם.',
  'Ready everywhere': 'מוכן בכל מקום',
  'A native-feeling phone app and a responsive desktop PWA.': 'אפליקציה טבעית לטלפון ויישום רספונסיבי למחשב.',
  'Language and currency': 'שפה ומטבע',
  'Dates and amounts will follow these preferences.': 'התאריכים, המספרים והממשק יתאימו לבחירות שלכם.',
  'Create your first account': 'צרו את החשבון הראשון שלכם',
  'Balances are derived from this opening amount and your transactions.': 'היתרות מחושבות מסכום הפתיחה ומהתנועות שלכם.',
  'Make it yours': 'התאימו לטעמכם',
  'Follow the system or choose an accent that feels like you.': 'השתמשו בהגדרת המערכת או בחרו צבע שמתאים לכם.',
  Language: 'שפה', 'Base currency': 'מטבע בסיס',
  'Budgets, goals, and reports use this currency.': 'תקציבים, יעדים ודוחות משתמשים במטבע הזה.',
  'Search by currency name or code': 'חיפוש לפי שם מטבע או קוד',
  'Account name': 'שם החשבון', Everyday: 'יומיומי', 'Account type': 'סוג חשבון', Type: 'סוג',
  Checking: 'עו״ש', Cash: 'מזומן', Savings: 'חיסכון', Credit: 'אשראי', Wallet: 'ארנק',
  checking: 'עו״ש', cash: 'מזומן', savings: 'חיסכון', credit: 'אשראי', wallet: 'ארנק',
  'Opening balance': 'יתרת פתיחה',
  System: 'מערכת', Light: 'בהיר', Dark: 'כהה', Accent: 'צבע הדגשה', 'System accent': 'צבע המערכת',
  Back: 'חזרה', Continue: 'המשך', 'Start using Qashy': 'התחילו להשתמש ב־Qashy', 'Setting up…': 'מגדיר…',
  'Choose language': 'בחירת שפה', 'Choose base currency': 'בחירת מטבע בסיס',
  'Close language choices': 'סגירת אפשרויות השפה', 'Close base currency choices': 'סגירת אפשרויות המטבע',
  'Search base currency': 'חיפוש מטבע בסיס', 'No matching choices': 'לא נמצאו אפשרויות מתאימות',
  'A quieter view of your finances.': 'מבט רגוע יותר על הכספים שלכם.',
  'YOUR MONEY AT A GLANCE': 'הכסף שלכם במבט אחד', 'CURRENT NET WORTH': 'שווי נקי נוכחי',
  'INCOME THIS MONTH': 'הכנסות החודש', 'SPENT THIS MONTH': 'הוצאות החודש',
  Income: 'הכנסה', Spent: 'הוצאות', 'Net flow': 'תזרים נטו',
  'Cash flow': 'תזרים מזומנים', 'Spending rhythm': 'קצב ההוצאות', 'Spending by category': 'הוצאות לפי קטגוריה', 'By category': 'לפי קטגוריה',
  'Budget pulse': 'מצב התקציב', 'Accounts at a glance': 'חשבונות במבט אחד', 'Open plan': 'פתיחת התכנון',
  'Over budget — review the categories driving it.': 'חריגה מהתקציב — בדקו אילו קטגוריות גורמות לכך.',
  'Create a flexible monthly or custom budget to see your pace here.': 'צרו תקציב חודשי או מותאם כדי לראות כאן את הקצב שלכם.',
  'Create budget': 'יצירת תקציב', Manage: 'ניהול', 'Coming up': 'בהמשך', Skip: 'דילוג', 'Mark paid': 'סימון כשולם',
  'Recent activity': 'פעילות אחרונה', 'See all': 'הצגת הכול', 'See all transactions': 'הצגת כל התנועות',
  'Choose another month or open the full transaction list.': 'בחרו חודש אחר או פתחו את רשימת התנועות המלאה.',
  'Add the first transaction and Qashy will turn it into useful context.': 'הוסיפו את התנועה הראשונה ו־Qashy יהפוך אותה לתמונה שימושית.',
  Upcoming: 'בקרוב', upcoming: 'בקרוב', UPCOMING: 'בקרוב', SPENT: 'הוצא',
  'Your ledger is ready': 'היומן שלכם מוכן',
  'Add your first transaction to start seeing your financial rhythm.': 'הוסיפו תנועה ראשונה כדי להתחיל לראות את התמונה הפיננסית.',
  'No spending in this period': 'אין הוצאות בתקופה הזו', 'Add an expense to start the rhythm.': 'הוסיפו הוצאה כדי להתחיל.',
  'No spending yet': 'אין עדיין הוצאות', Uncategorized: 'ללא קטגוריה', Other: 'אחר',
  'Previous month': 'החודש הקודם', 'Next month': 'החודש הבא',
  'Search, filter, and manage your local ledger.': 'חפשו, סננו ונהלו את היומן המקומי שלכם.',
  'Search transactions': 'חיפוש תנועות', 'Search title or note': 'חיפוש בכותרת או בהערה',
  All: 'הכול', Expense: 'הוצאה', Transfer: 'העברה',
  all: 'הכול', expense: 'הוצאה', income: 'הכנסה', transfer: 'העברה',
  Select: 'בחירה', 'Done selecting': 'סיום בחירה', 'Import or export': 'ייבוא או ייצוא',
  Clear: 'ניקוי', Done: 'סיום', 'Change category': 'שינוי קטגוריה',
  'Select only income or only expense transactions to assign a category.': 'בחרו רק תנועות הכנסה או רק תנועות הוצאה כדי לשייך קטגוריה.',
  'Delete selected': 'מחיקת הנבחרות', 'Choose one or more transactions below.': 'בחרו תנועה אחת או יותר למטה.',
  'Nothing matches': 'אין תוצאות מתאימות', 'No transactions yet': 'אין עדיין תנועות',
  'Try another search or filter.': 'נסו חיפוש או סינון אחר.', 'Add your first income, expense, or transfer.': 'הוסיפו הכנסה, הוצאה או העברה ראשונה.',
  'Add transaction': 'הוספת תנועה', Title: 'כותרת', Date: 'תאריך', Note: 'הערה',
  Status: 'מצב', Amount: 'סכום', Tags: 'תגיות', Notes: 'הערות', 'Destination account': 'חשבון יעד',
  'Destination amount': 'סכום יעד', 'Destination base amount (minor units)': 'סכום בסיס ביעד (יחידות משנה)',
  'What was it?': 'על מה זה היה?', 'From account': 'מחשבון', 'To account': 'לחשבון',
  'Transfers need two accounts': 'העברות דורשות שני חשבונות',
  'Add another account, then return here to finish this transfer. Your draft will stay open.': 'הוסיפו חשבון נוסף ואז חזרו לכאן כדי להשלים את ההעברה. הטיוטה תישמר.',
  'Add another account': 'הוספת חשבון נוסף',
  'Calculated from saved rates': 'מחושב משערים שמורים',
  'The destination receives the same amount; same-currency transfers always conserve value.': 'חשבון היעד מקבל את אותו הסכום; העברות באותו מטבע תמיד שומרות על הערך.',
  'Use saved effective rate': 'שימוש בשער השמור',
  'Leave blank to use the saved rate for this date. The applied rate is snapshotted.': 'השאירו ריק כדי להשתמש בשער השמור לתאריך הזה. השער שיוחל יישמר.',
  'Optional context': 'הקשר אופציונלי', 'Make this recurring instead': 'הפיכה לתנועה מחזורית',
  'Save changes': 'שמירת שינויים', 'Delete transaction': 'מחיקת תנועה', Saving: 'שומר', 'Saving…': 'שומר…',
  'Set flexible limits and track progress toward meaningful goals.': 'הגדירו גבולות גמישים ועקבו אחר התקדמות ליעדים משמעותיים.',
  Budgets: 'תקציבים', Goals: 'יעדים', Edit: 'עריכה', Open: 'פתיחה', spent: 'הוצאו', left: 'נותרו',
  'Give spending a gentle boundary': 'תנו להוצאות גבול נעים',
  'Create a monthly, weekly, yearly, or one-off budget. Nothing is forced into envelopes.': 'צרו תקציב חודשי, שבועי, שנתי או חד־פעמי. בלי לכפות שיטת מעטפות.',
  'Create a budget': 'יצירת תקציב', 'Save toward something real': 'חסכו למשהו אמיתי',
  'Track a savings target or a planned purchase with manual or linked progress.': 'עקבו אחר יעד חיסכון או רכישה מתוכננת באמצעות התקדמות ידנית או מקושרת.',
  'Create a goal': 'יצירת יעד', Period: 'תקופה', Day: 'יום', Week: 'שבוע', Month: 'חודש', Year: 'שנה', Custom: 'מותאם',
  day: 'יום', week: 'שבוע', month: 'חודש', year: 'שנה', custom: 'מותאם',
  'Budget name': 'שם התקציב', 'Total limit': 'מגבלה כוללת', 'End date': 'תאריך סיום', Rollover: 'העברה לתקופה הבאה',
  'Carry both surplus and overspend forward.': 'העבירו גם עודף וגם חריגה לתקופה הבאה.',
  'Categories and caps': 'קטגוריות ומגבלות', 'Leave every category unselected to count all expenses.': 'השאירו את כל הקטגוריות לא מסומנות כדי לכלול את כל ההוצאות.',
  'No cap': 'ללא מגבלה', 'Save budget': 'שמירת תקציב', 'Delete budget': 'מחיקת תקציב',
  'Savings goal': 'יעד חיסכון', 'Planned purchase': 'רכישה מתוכננת', 'Goal name': 'שם היעד',
  'Starting progress': 'התקדמות התחלתית', 'Target date (optional)': 'תאריך יעד (אופציונלי)',
  'Automatic progress': 'התקדמות אוטומטית',
  'Optionally count matching posted transactions. You can still add progress manually.': 'אפשר לכלול תנועות תואמות שנרשמו. עדיין ניתן להוסיף התקדמות ידנית.',
  'Linked account': 'חשבון מקושר', 'Linked category': 'קטגוריה מקושרת', None: 'ללא',
  'Add a manual contribution': 'הוספת הפקדה ידנית', 'Save goal': 'שמירת יעד', 'Delete goal': 'מחיקת יעד',
  'Accounts, categories, automation, portability, and appearance.': 'חשבונות, קטגוריות, אוטומציה, ניידות ומראה.',
  Accounts: 'חשבונות', Add: 'הוספה', Categories: 'קטגוריות', Automation: 'אוטומציה',
  'New recurring': 'מחזורית חדשה', 'Exchange rates': 'שערי חליפין', 'Add rate': 'הוספת שער', Archived: 'בארכיון',
  'Subscriptions and scheduled income will appear here.': 'מינויים והכנסות מתוזמנות יופיעו כאן.',
  'Add a manual rate when you create an account in another currency.': 'הוסיפו שער ידני כשיוצרים חשבון במטבע אחר.',
  Restore: 'שחזור', 'Restoring…': 'משחזר…',
  'Theme, Material You, and accent': 'ערכת נושא, Material You וצבע הדגשה',
  'CSV portability': 'ניידות באמצעות CSV', 'Reset all data': 'איפוס כל הנתונים',
  'Delete everything and return to first-time setup': 'מחיקת הכול וחזרה להגדרה הראשונית', 'Resetting…': 'מאפס…',
  Privacy: 'פרטיות', 'Local-first · no account · no tracking': 'מקומי בלבד · ללא חשבון · ללא מעקב',
  Currency: 'מטבע', 'Changing this adjusts the derived account balance.': 'שינוי זה מעדכן את יתרת החשבון המחושבת.',
  Color: 'צבע', 'Save account': 'שמירת חשבון', 'Create account': 'יצירת חשבון', 'Archive account': 'העברת חשבון לארכיון',
  'Category name': 'שם הקטגוריה', Icon: 'סמל', 'Parent category': 'קטגוריית אב',
  'Save category': 'שמירת קטגוריה', 'Create category': 'יצירת קטגוריה', 'Archive category': 'העברת קטגוריה לארכיון',
  Repeats: 'חוזר', Every: 'כל', Starts: 'מתחיל', 'Ends (optional)': 'מסתיים (אופציונלי)',
  Active: 'פעיל', Paused: 'מושהה', Ended: 'הסתיים', Monthly: 'חודשי',
  'Save schedule': 'שמירת תזמון', 'Create schedule': 'יצירת תזמון', 'Delete schedule': 'מחיקת תזמון',
  'Accent source': 'מקור צבע ההדגשה', 'Qashy default': 'ברירת המחדל של Qashy', 'Material You wallpaper': 'טפט Material You',
  'Android 12 and later derive this from your wallpaper. Older versions use Qashy’s default palette.': 'ב־Android 12 ומעלה הצבע נגזר מהטפט. גרסאות ישנות משתמשות בצבעי ברירת המחדל של Qashy.',
  'Uses Qashy’s indigo accent on neutral surfaces.': 'משתמש בצבע האינדיגו של Qashy על משטחים ניטרליים.',
  'Curated accents': 'צבעים נבחרים', 'Custom accent': 'צבע מותאם', PREVIEW: 'תצוגה מקדימה',
  'Only the accent changes. Qashy gently adjusts unsafe colors to preserve contrast.': 'רק צבע ההדגשה משתנה. Qashy מתאים בעדינות צבעים בעייתיים כדי לשמור על ניגודיות.',
  'Color, contrast, and clarity': 'צבע, ניגודיות ובהירות',
  'Qashy adapts the same hierarchy across iOS, Android, and desktop.': 'Qashy מתאים את אותה היררכיה ל־iOS, ל־Android ולמחשב.',
  'Save appearance': 'שמירת מראה', Saved: 'נשמר',
  'Export transactions': 'ייצוא תנועות', 'Export CSV': 'ייצוא CSV', 'Import transactions': 'ייבוא תנועות',
  'Creates a UTF-8 CSV with dates, statuses, amounts, currencies, source and destination accounts, categories, tags, notes, exchange-rate snapshots, and transfer linkage.': 'יוצר קובץ CSV בקידוד UTF-8 עם תאריכים, מצבים, סכומים, מטבעות, חשבונות מקור ויעד, קטגוריות, תגיות, הערות, שערי חליפין וקישורי העברות.',
  'Headers are matched automatically. Required columns are date, type, title, amount, currency, and account. Nothing is committed until after preview.': 'הכותרות מותאמות אוטומטית. העמודות הנדרשות הן תאריך, סוג, כותרת, סכום, מטבע וחשבון. דבר לא נשמר לפני התצוגה המקדימה.',
  'Choose CSV': 'בחירת CSV', 'Column mapping': 'מיפוי עמודות', Required: 'חובה', 'Not mapped': 'לא ממופה',
  'Choose the source column for each Qashy field. Optional fields can stay Not mapped.': 'בחרו את עמודת המקור לכל שדה ב־Qashy. שדות אופציונליים יכולים להישאר לא ממופים.',
  'Default account': 'חשבון ברירת מחדל', 'Default category': 'קטגוריית ברירת מחדל',
  'Preview import': 'תצוגה מקדימה לייבוא', Ready: 'מוכן', Duplicates: 'כפילויות', Rejected: 'נדחו',
  'From currency': 'ממטבע', 'Effective date': 'תאריך תחולה', 'Save rate': 'שמירת שער', 'Delete rate': 'מחיקת שער',
  'Try again.': 'נסו שוב.', 'Check the form and try again.': 'בדקו את הטופס ונסו שוב.',
  Delete: 'מחיקה', Cancel: 'ביטול', 'Primary': 'ראשי', 'A fresh version is ready': 'גרסה חדשה מוכנה', Later: 'אחר כך', Reload: 'טעינה מחדש',
  'Reload when you’re ready. Your finance data stays in IndexedDB.': 'טענו מחדש כשתהיו מוכנים. המידע הפיננסי נשאר ב־IndexedDB.',
  'LOCAL-FIRST FINANCE': 'כספים מקומיים תחילה', 'Your data stays on this device.': 'הנתונים שלכם נשארים במכשיר הזה.',
};

function translateDynamic(message: string) {
  const patterns: [RegExp, (...parts: string[]) => string][] = [
    [/^(\d+) choices available$/, (count) => `${count} אפשרויות זמינות`],
    [/^(\d+) transactions$/, (count) => `${count} תנועות`],
    [/^(\d+) transaction$/, (count) => `תנועה אחת`],
    [/^(\d+) selected$/, (count) => `${count} נבחרו`],
    [/^Amount \((.+)\)$/, (currency) => `סכום (${currency})`],
    [/^Opening balance \((.+)\)$/, (currency) => `יתרת פתיחה (${currency})`],
    [/^Destination amount \((.+)\)$/, (currency) => `סכום יעד (${currency})`],
    [/^Target \((.+)\)$/, (currency) => `יעד (${currency})`],
    [/^Next (.+)$/, (date) => `הבא: ${date}`],
    [/^Effective (.+)$/, (date) => `בתוקף מ־${date}`],
    [/^No activity in (.+)$/, (month) => `אין פעילות ב${month}`],
    [/^Import (\d+) transactions$/, (count) => `ייבוא ${count} תנועות`],
    [/^Row (\d+): (.+)$/, (row, reason) => `שורה ${row}: ${reason}`],
    [/^Use (#[0-9A-Fa-f]{6}) (.+)$/, (color, item) => `שימוש ב־${color} עבור ${translateMessage(item, 'he')}`],
    [/^Archived account · (.+)$/, (currency) => `חשבון בארכיון · ${currency}`],
    [/^Archived (.+) category$/, (kind) => `קטגוריית ${translateMessage(kind, 'he')} בארכיון`],
  ];
  for (const [pattern, replacement] of patterns) {
    const match = message.match(pattern);
    if (match) return replacement(...match.slice(1));
  }
  return message;
}

export function languageFromLocale(locale: string): AppLanguage {
  return locale.toLocaleLowerCase().startsWith('he') ? 'he' : 'en';
}

export function translateMessage(message: string, language: AppLanguage) {
  if (language === 'en' || !message) return message;
  const leading = message.match(/^\s*/)?.[0] ?? '';
  const trailing = message.match(/\s*$/)?.[0] ?? '';
  const core = message.slice(leading.length, message.length - trailing.length || undefined);
  const translated = HEBREW[core] ?? translateDynamic(core);
  return `${leading}${translated}${trailing}`;
}

type LocalizationValue = {
  language: AppLanguage;
  locale: string;
  isRtl: boolean;
  t: (message: string) => string;
};

const LocalizationContext = createContext<LocalizationValue | null>(null);
let currentLanguage: AppLanguage = 'en';

export function LocalizationProvider({ children }: { children: ReactNode }) {
  const { settings } = useFinanceState();
  const language = languageFromLocale(settings.locale);
  const value = useMemo<LocalizationValue>(() => ({
    language,
    locale: settings.locale,
    isRtl: language === 'he',
    t: (message) => translateMessage(message, language),
  }), [language, settings.locale]);
  useEffect(() => {
    currentLanguage = language;
  }, [language]);
  return <LocalizationContext value={value}>{children}</LocalizationContext>;
}

export function translateCurrent(message: string) {
  return translateMessage(message, currentLanguage);
}

export function useLocalization() {
  const value = use(LocalizationContext);
  if (!value) throw new Error('useLocalization must be used inside LocalizationProvider.');
  return value;
}
