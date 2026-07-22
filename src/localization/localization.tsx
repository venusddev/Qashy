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
  'Transfers do not have categories. Select only income or expense transactions to change categories.': 'להעברות אין קטגוריות. בחרו רק תנועות הכנסה או הוצאה כדי לשנות קטגוריות.',
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
  'Create a goal': 'יצירת יעד', 'Create goal': 'יצירת יעד', Period: 'תקופה', Day: 'יום', Week: 'שבוע', Month: 'חודש', Year: 'שנה', Custom: 'מותאם',
  day: 'יום', week: 'שבוע', month: 'חודש', year: 'שנה', custom: 'מותאם',
  to: 'עד', rollover: 'העברה', by: 'עד', of: 'מתוך', required: 'חובה',
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
  'Post automatically': 'רישום אוטומטי',
  'Off by default. Upcoming items wait for your review.': 'כבוי כברירת מחדל. תנועות עתידיות ממתינות לבדיקה שלכם.',
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
  'The default category is used only for rows with the same transaction type. Other rows stay uncategorized.': 'קטגוריית ברירת המחדל משמשת רק שורות מאותו סוג תנועה. שורות אחרות נשארות ללא קטגוריה.',
  'Preview import': 'תצוגה מקדימה לייבוא', Ready: 'מוכן', Duplicates: 'כפילויות', Rejected: 'נדחו',
  'From currency': 'ממטבע', 'Effective date': 'תאריך תחולה', 'Save rate': 'שמירת שער', 'Delete rate': 'מחיקת שער',
  'Try again.': 'נסו שוב.', 'Check the form and try again.': 'בדקו את הטופס ונסו שוב.',
  Target: 'יעד', Contribution: 'הפקדה', 'Contribution date': 'תאריך ההפקדה',
  'Contribution amount': 'סכום ההפקדה', 'Contribution note': 'הערת הפקדה',
  'Start date': 'תאריך התחלה', 'Target date': 'תאריך יעד', 'Repeat interval': 'מרווח חזרה',
  'Category cap': 'מגבלת קטגוריה', 'Budget limit': 'מגבלת תקציב', 'Recurring amount': 'סכום מחזורי',
  'Destination base amount': 'סכום בסיס ביעד', Value: 'ערך', 'cap (optional)': 'מגבלה (אופציונלי)',
  'Manual contribution': 'הפקדה ידנית', 'Manual contributions': 'הפקדות ידניות',
  'No manual contributions yet.': 'אין עדיין הפקדות ידניות.',
  'Save contribution': 'שמירת הפקדה', 'Add contribution': 'הוספת הפקדה',
  'A category with child categories must stay at the top level.': 'קטגוריה שיש לה קטגוריות משנה חייבת להישאר ברמה העליונה.',
  'Use a valid locale such as en-US.': 'השתמשו בהגדרת אזור תקינה, למשל he-IL.',
  'Use a three-letter currency code such as USD.': 'השתמשו בקוד מטבע בן שלוש אותיות, למשל ILS.',
  'Use a supported ISO 4217 currency code.': 'השתמשו בקוד מטבע נתמך מתקן ISO 4217.',
  'Enter a valid number.': 'הזינו מספר תקין.', 'Enter a valid amount.': 'הזינו סכום תקין.',
  'Amount is outside the supported range.': 'הסכום מחוץ לטווח הנתמך.',
  'Converted amount is outside the supported range.': 'הסכום שהומר מחוץ לטווח הנתמך.',
  'Exchange rate must be a positive number.': 'שער החליפין חייב להיות מספר חיובי.',
  'Use a six-digit hex color such as #5966E9.': 'השתמשו בצבע הקסדצימלי בן שש ספרות, למשל #5966E9.',
  'Use a real date in YYYY-MM-DD format.': 'השתמשו בתאריך אמיתי בתבנית YYYY-MM-DD.',
  'Choose a destination account.': 'בחרו חשבון יעד.',
  'Currency is locked because this account has transaction or schedule history.': 'המטבע נעול משום שלחשבון הזה יש היסטוריית תנועות או תזמונים.',
  'End date must not precede the start date.': 'תאריך הסיום אינו יכול להיות לפני תאריך ההתחלה.',
  'End date must not precede the budget start date.': 'תאריך הסיום אינו יכול להיות לפני תאריך תחילת התקציב.',
  'Qashy setup is already complete.': 'הגדרת Qashy כבר הושלמה.',
  'Choose a valid account type.': 'בחרו סוג חשבון תקין.', 'Choose a valid theme mode.': 'בחרו מצב ערכת נושא תקין.',
  'Choose a valid accent source.': 'בחרו מקור צבע הדגשה תקין.',
  'Base currency cannot change after setup is complete.': 'לא ניתן לשנות את מטבע הבסיס לאחר השלמת ההגדרה.',
  'Account currency cannot change after transactions or schedules reference it.': 'לא ניתן לשנות את מטבע החשבון לאחר שתנועות או תזמונים מפנים אליו.',
  'Choose a valid category kind.': 'בחרו סוג קטגוריה תקין.',
  'Category kind cannot change after finance records reference it.': 'לא ניתן לשנות את סוג הקטגוריה לאחר שרשומות כספיות מפנות אליה.',
  'Choose a valid top-level parent category of the same kind.': 'בחרו קטגוריית אב תקינה מאותו סוג וברמה העליונה.',
  'A category with child categories cannot also have a parent.': 'קטגוריה שיש לה קטגוריות משנה אינה יכולה להיות גם קטגוריית בת.',
  'Tag name is required.': 'יש להזין שם תגית.', 'Choose a valid transaction.': 'בחרו תנועה תקינה.',
  'Choose a valid goal.': 'בחרו יעד תקין.', 'Exchange-rate currencies must be different.': 'מטבעות שער החליפין חייבים להיות שונים.',
  'A rate already exists for this currency pair and date.': 'כבר קיים שער לצמד המטבעות ולתאריך הזה.',
  'Transfers do not have categories.': 'להעברות אין קטגוריות.', 'Choose a valid category.': 'בחרו קטגוריה תקינה.',
  'Choose a valid transaction type.': 'בחרו סוג תנועה תקין.', 'Choose a valid transaction status.': 'בחרו מצב תנועה תקין.',
  'Choose a valid account.': 'בחרו חשבון תקין.', 'Choose a different destination account.': 'בחרו חשבון יעד אחר.',
  'Choose valid tags.': 'בחרו תגיות תקינות.', 'Budget interval must be a positive whole number.': 'מרווח התקציב חייב להיות מספר שלם וחיובי.',
  'Choose a valid budget period.': 'בחרו תקופת תקציב תקינה.', 'Custom budgets require an end date.': 'תקציב מותאם דורש תאריך סיום.',
  'Budget end date must not precede its start date.': 'תאריך סיום התקציב אינו יכול להיות לפני תאריך ההתחלה.',
  'Each category can have only one limit.': 'לכל קטגוריה יכולה להיות מגבלה אחת בלבד.',
  'Category limits must belong to the budget filters.': 'מגבלות קטגוריה חייבות להשתייך למסנני התקציב.',
  'Choose a valid goal kind.': 'בחרו סוג יעד תקין.', 'Starting progress cannot be negative.': 'התקדמות התחלתית אינה יכולה להיות שלילית.',
  'Choose a valid linked account.': 'בחרו חשבון מקושר תקין.', 'Choose a valid recurring transaction kind.': 'בחרו סוג תנועה מחזורית תקין.',
  'Choose a valid recurrence period.': 'בחרו תקופת חזרה תקינה.', 'Schedule end date must not precede its start date.': 'תאריך סיום התזמון אינו יכול להיות לפני תאריך ההתחלה.',
  'Repeat interval must be a positive whole number.': 'מרווח החזרה חייב להיות מספר שלם וחיובי.',
  'Recurring currency must match its account.': 'מטבע התנועה המחזורית חייב להתאים לחשבון.',
  'Couldn’t apply this setting': 'לא ניתן להחיל את ההגדרה', 'Couldn’t finish setup': 'לא ניתן להשלים את ההגדרה',
  'Couldn’t restore': 'לא ניתן לשחזר', 'Couldn’t finish resetting Qashy': 'לא ניתן להשלים את איפוס Qashy',
  'Couldn’t save account': 'לא ניתן לשמור את החשבון', 'Couldn’t archive account': 'לא ניתן להעביר את החשבון לארכיון',
  'Couldn’t save category': 'לא ניתן לשמור את הקטגוריה', 'Couldn’t archive category': 'לא ניתן להעביר את הקטגוריה לארכיון',
  'Couldn’t save transaction': 'לא ניתן לשמור את התנועה', 'Couldn’t delete transaction': 'לא ניתן למחוק את התנועה',
  'Couldn’t delete transactions': 'לא ניתן למחוק את התנועות', 'Couldn’t change category': 'לא ניתן לשנות את הקטגוריה',
  'Couldn’t save budget': 'לא ניתן לשמור את התקציב', 'Couldn’t delete budget': 'לא ניתן למחוק את התקציב',
  'Couldn’t save goal': 'לא ניתן לשמור את היעד', 'Couldn’t delete goal': 'לא ניתן למחוק את היעד',
  'Couldn’t save contribution': 'לא ניתן לשמור את ההפקדה', 'Couldn’t delete contribution': 'לא ניתן למחוק את ההפקדה',
  'Couldn’t save schedule': 'לא ניתן לשמור את התזמון', 'Couldn’t delete schedule': 'לא ניתן למחוק את התזמון',
  'Couldn’t save rate': 'לא ניתן לשמור את השער', 'Couldn’t delete rate': 'לא ניתן למחוק את השער',
  'Couldn’t save appearance': 'לא ניתן לשמור את המראה', 'Couldn’t read CSV': 'לא ניתן לקרוא את קובץ ה־CSV',
  'Couldn’t import CSV': 'לא ניתן לייבא את קובץ ה־CSV', 'Couldn’t export CSV': 'לא ניתן לייצא את קובץ ה־CSV',
  'Couldn’t skip this item': 'לא ניתן לדלג על הפריט', 'Couldn’t mark this item paid': 'לא ניתן לסמן את הפריט כשולם',
  'Delete this transaction?': 'למחוק את התנועה הזו?', 'Delete this schedule?': 'למחוק את התזמון הזה?',
  'Delete this contribution?': 'למחוק את ההפקדה הזו?', 'Delete 1 transaction?': 'למחוק תנועה אחת?',
  'Already generated transactions stay in your ledger.': 'תנועות שכבר נוצרו יישארו ביומן.',
  'They will be removed from your ledger.': 'הן יוסרו מהיומן.', 'Manual contributions are removed with it.': 'ההפקדות הידניות יימחקו יחד איתו.',
  'Past period snapshots are removed with it.': 'תמונות המצב של תקופות קודמות יימחקו יחד איתו.',
  'Transactions that need this rate will report it as missing.': 'תנועות שזקוקות לשער הזה ידווחו שהוא חסר.',
  'The category is hidden from lists and pickers. You can restore it from the Archived section in More.': 'הקטגוריה תוסתר מרשימות ומבוררים. ניתן לשחזר אותה מאזור הארכיון במסך עוד.',
  'The account is hidden from lists and pickers. You can restore it from the Archived section in More.': 'החשבון יוסתר מרשימות ומבוררים. ניתן לשחזר אותו מאזור הארכיון במסך עוד.',
  Archive: 'העברה לארכיון', 'Reset everything': 'איפוס הכול',
  'Reset Qashy?': 'לאפס את Qashy?',
  'This permanently deletes every account, transaction, budget, goal, recurring transaction, exchange rate, category, and setting stored by Qashy on this device. This cannot be undone.': 'פעולה זו מוחקת לצמיתות כל חשבון, תנועה, תקציב, יעד, תנועה מחזורית, שער חליפין, קטגוריה והגדרה ששמורים ב־Qashy במכשיר הזה. לא ניתן לבטל אותה.',
  'Rename the active entry using this name first.': 'שנו תחילה את שם הרשומה הפעילה שמשתמשת בשם הזה.',
  'Restart the app and try again.': 'הפעילו מחדש את האפליקציה ונסו שוב.',
  'Try a compatible category.': 'נסו קטגוריה תואמת.', 'Choose another UTF-8 CSV file.': 'בחרו קובץ CSV אחר בקידוד UTF-8.',
  'No rows were imported.': 'לא יובאו שורות.', 'No transactions found': 'לא נמצאו תנועות',
  'Choose a CSV with a header row and at least one data row.': 'בחרו קובץ CSV עם שורת כותרת ולפחות שורת נתונים אחת.',
  'Import complete': 'הייבוא הושלם',
  'Rejected rows were not imported.': 'שורות שנדחו לא יובאו.', 'Likely duplicates were skipped.': 'כפילויות אפשריות דולגו.',
  Delete: 'מחיקה', Cancel: 'ביטול', 'Primary': 'ראשי', 'A fresh version is ready': 'גרסה חדשה מוכנה', Later: 'אחר כך', Reload: 'טעינה מחדש',
  'Reload when you’re ready. Your finance data stays in IndexedDB.': 'טענו מחדש כשתהיו מוכנים. המידע הפיננסי נשאר ב־IndexedDB.',
  'LOCAL-FIRST FINANCE': 'כספים מקומיים תחילה', 'Your data stays on this device.': 'הנתונים שלכם נשארים במכשיר הזה.',
  Groceries: 'מצרכים', Dining: 'מסעדות', Transport: 'תחבורה', Home: 'בית', Health: 'בריאות', Fun: 'פנאי',
  Salary: 'משכורת', 'Other income': 'הכנסה אחרת',
};

function translateDynamic(message: string) {
  const translateField = (field: string) => translateMessage(
    field ? `${field[0].toUpperCase()}${field.slice(1)}` : field,
    'he',
  );
  const patterns: [RegExp, (...parts: string[]) => string][] = [
    [/^(\d+) choices available$/, (count) => `${count} אפשרויות זמינות`],
    [/^(\d+) transactions$/, (count) => `${count} תנועות`],
    [/^(\d+) transaction$/, (count) => `תנועה אחת`],
    [/^(\d+) selected$/, (count) => `${count} נבחרו`],
    [/^Amount \((.+)\)$/, (currency) => `סכום (${currency})`],
    [/^Opening balance \((.+)\)$/, (currency) => `יתרת פתיחה (${currency})`],
    [/^Destination amount \((.+)\)$/, (currency) => `סכום יעד (${currency})`],
    [/^Target \((.+)\)$/, (currency) => `יעד (${currency})`],
    [/^(.+) \((.+)\)$/, (label, value) => `${translateField(label)} (${value})`],
    [/^Next (.+)$/, (date) => `הבא: ${date}`],
    [/^Effective (.+)$/, (date) => `בתוקף מ־${date}`],
    [/^No activity in (.+)$/, (month) => `אין פעילות ב${month}`],
    [/^Import (\d+) transactions$/, (count) => `ייבוא ${count} תנועות`],
    [/^Row (\d+): (.+)$/, (row, reason) => `שורה ${row}: ${translateMessage(reason, 'he')}`],
    [/^Use (#[0-9A-Fa-f]{6}) (.+)$/, (color, item) => `שימוש ב־${color} עבור ${translateMessage(item, 'he')}`],
    [/^Archived account · (.+)$/, (currency) => `חשבון בארכיון · ${currency}`],
    [/^Archived (.+) category$/, (kind) => `קטגוריית ${translateMessage(kind, 'he')} בארכיון`],
    [/^Every (\d+) (day|week|month|year)s?\.$/, (count, unit) => `כל ${count} ${translateMessage(unit, 'he')}`],
    [/^(\d+)% remains in this period\.$/, (percent) => `${percent}% נותרו בתקופה הזו.`],
    [/^(.+) is required\.$/, (label) => `יש למלא את השדה ${translateField(label)}.`],
    [/^(.+) must be greater than zero\.$/, (label) => `${translateField(label)} חייב להיות גדול מאפס.`],
    [/^(.+) cannot be negative\.$/, (label) => `${translateField(label)} אינו יכול להיות שלילי.`],
    [/^Enter a valid (.+)\.$/, (label) => `הזינו ${translateField(label)} תקין.`],
    [/^Use a real (.+) in YYYY-MM-DD format\.$/, (label) => `השתמשו ב${translateField(label)} אמיתי בתבנית YYYY-MM-DD.`],
    [/^(.+) must be a positive whole number\.$/, (label) => `${translateField(label)} חייב להיות מספר שלם וחיובי.`],
    [/^(.+) must be a whole number\.$/, (label) => `${translateField(label)} חייב להיות מספר שלם.`],
    [/^(.+) can have at most (\d+) decimal places\.$/, (label, digits) => `ל${translateField(label)} יכולות להיות לכל היותר ${digits} ספרות אחרי הנקודה.`],
    [/^(.+) is outside the supported range\.$/, (label) => `${translateField(label)} מחוץ לטווח הנתמך.`],
    [/^Choose a valid (expense|income) category\.$/, (kind) => `בחרו קטגוריית ${translateMessage(kind, 'he')} תקינה.`],
    [/^Choose valid (.+) values\.$/, (label) => `בחרו ערכי ${translateField(label)} תקינים.`],
    [/^Could not find the (.+) to update\.$/, (label) => `לא נמצאה רשומת ${translateField(label)} לעדכון.`],
    [/^(.+) is already in use\.$/, (name) => `השם ${name} כבר בשימוש.`],
    [/^Missing exchange rate for (.+) → (.+) on (.+)\.$/, (from, to, date) => `חסר שער חליפין מ־${from} ל־${to} בתאריך ${date}.`],
    [/^The (.+) category can only be assigned to (expense|income) transactions\.$/, (name, kind) => `ניתן לשייך את הקטגוריה ${name} רק לתנועות ${translateMessage(kind, 'he')}.`],
    [/^Currency (.+) does not match (.+) \((.+)\)\.$/, (currency, account, expected) => `המטבע ${currency} אינו תואם לחשבון ${account} (${expected}).`],
    [/^Unknown account: (.+)$/, (account) => `חשבון לא מוכר: ${account}`],
    [/^Unknown destination account: (.+)$/, (account) => `חשבון יעד לא מוכר: ${account}`],
    [/^Unknown category: (.+)$/, (category) => `קטגוריה לא מוכרת: ${category}`],
    [/^Unsupported currency or locale: (.+) \((.+)\)\.$/, (currency, locale) => `מטבע או הגדרת אזור אינם נתמכים: ${currency} (${locale}).`],
    [/^This contradicts the existing (.+) → (.+) rate of (.+), which implies (.+)\. Update or remove that rate first\.$/, (from, to, rate, implied) => `הערך סותר את השער הקיים מ־${from} ל־${to}, שערכו ${rate} ומשמעותו ${implied}. עדכנו או הסירו תחילה את השער הזה.`],
    [/^Archive (.+)\?$/, (name) => `להעביר את ${name} לארכיון?`],
    [/^Delete the (.+) rate\?$/, (currency) => `למחוק את שער ${currency}?`],
    [/^Delete (\d+) transactions\?$/, (count) => `למחוק ${count} תנועות?`],
    [/^Delete (.+)\?$/, (name) => `למחוק את ${name}?`],
    [/^“(.+)” will be removed from your ledger\.$/, (title) => `״${title}״ תוסר מהיומן.`],
    [/^(.+) from (\d{4}-\d{2}-\d{2}) will be removed from this goal\.$/, (amount, date) => `${amount} מתאריך ${date} יוסר מהיעד הזה.`],
    [/^(\d+) transactions imported\.$/, (count) => `יובאו ${count} תנועות.`],
    [/^Skipped (\d+) unreadable (row|rows)$/, (count) => `דולגו ${count} שורות שלא ניתן לקרוא`],
    [/^The rest of the file was read\. Check (?:line|lines) (.+) for stray quotes\.$/, (lines) => `שאר הקובץ נקרא. בדקו בשורות ${lines} אם יש מירכאות מיותרות.`],
    [/^Map required fields: (.+)\.$/, (fields) => `מפו את שדות החובה: ${fields}.`],
    [/^Malformed CSV quote on line (\d+)\.$/, (line) => `מירכאות CSV לא תקינות בשורה ${line}.`],
    [/^Unclosed quoted CSV field starting on line (\d+)\.$/, (line) => `שדה CSV במירכאות לא נסגר החל משורה ${line}.`],
    [/^1 (.+) equals how many (.+)\?$/, (from, to) => `לכמה ${to} שווה 1 ${from}?`],
    [/^Edit contribution (.+)$/, (amount) => `עריכת הפקדה ${amount}`],
    [/^Delete contribution (.+)$/, (amount) => `מחיקת הפקדה ${amount}`],
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
    if (process.env.EXPO_OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.lang = language === 'he' ? 'he-IL' : 'en-US';
      document.documentElement.dir = language === 'he' ? 'rtl' : 'ltr';
    }
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
