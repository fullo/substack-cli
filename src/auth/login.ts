import { UsageError } from '../util/errors.ts';

interface PwPage { goto(url: string): Promise<unknown> }
interface PwContext { newPage(): Promise<PwPage>; cookies(url: string): Promise<{ name: string; value: string }[]> }
interface PwBrowser { newContext(): Promise<PwContext>; close(): Promise<void> }
interface Playwright { chromium: { launch(opts: { headless: boolean }): Promise<PwBrowser> } }

export async function browserLogin(timeoutMs = 5 * 60_000): Promise<string> {
  const moduleName = 'playwright'; // nome in variabile: non è una dipendenza del progetto
  let pw: Playwright;
  try {
    pw = (await import(moduleName)) as Playwright;
  } catch {
    throw new UsageError(
      'Playwright non è installato. Sul tuo PC esegui: npm install --no-save playwright && npx playwright install chromium, poi riprova.',
    );
  }
  const browser = await pw.chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://substack.com/sign-in');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cookie = (await context.cookies('https://substack.com')).find((c) => c.name === 'substack.sid');
      if (cookie) return cookie.value;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new UsageError('Tempo scaduto in attesa del login');
  } finally {
    await browser.close();
  }
}
