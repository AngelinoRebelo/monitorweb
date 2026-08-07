/**
 * Local regression tests for recent MonitorWeb fixes.
 * Run: node scripts/smoke-tests.mjs
 */
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getEffectiveEmailDailyLimit, getTrialDefaults } from '../server/billing.js';
import { hasUsefulSeiContent, isSeiCaptchaWall, isSeiEmptyOrMissing } from '../server/seiCapture.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('\n== Limite diário de e-mail ==');
test('valor salvo pelo admin não é cortado pelo trial', () => {
  const user = {
    role: 'user',
    emailNotifyDailyLimit: 50,
    emailNotifyAllowed: true,
    billingActive: true,
    billingTrialEndsAt: new Date(Date.now() + 86400000 * 10).toISOString(),
    billingExpiresAt: null,
    billingPermanent: false,
    billingPlanId: null,
  };
  assert.equal(getEffectiveEmailDailyLimit(user), 50);
});

test('sem valor explícito usa default do trial', () => {
  const trial = getTrialDefaults();
  const user = {
    role: 'user',
    emailNotifyDailyLimit: null,
    billingActive: true,
    billingTrialEndsAt: new Date(Date.now() + 86400000 * 10).toISOString(),
    billingExpiresAt: null,
    billingPermanent: false,
    billingPlanId: null,
  };
  assert.equal(getEffectiveEmailDailyLimit(user), trial.emailDailyLimit);
});

test('zero explícito é respeitado', () => {
  assert.equal(getEffectiveEmailDailyLimit({ role: 'user', emailNotifyDailyLimit: 0 }), 0);
});

console.log('\n== Detecção SEI (helpers) ==');
test('conteúdo útil de processo é reconhecido', () => {
  const text = `[protocolos]
138456309 | Despacho de Encaminhamento de Processo | 06/08/2026 | SEPPEN/CHEGAB
[andamentos]
06/08/2026 18:45 | SEPPEN/GABSEC | Processo remetido pela unidade SEPPEN/CHEGAB`;
  assert.equal(hasUsefulSeiContent(text), true);
  assert.equal(isSeiCaptchaWall('Digite o código da imagem', text), false);
});

test('captcha puro é parede', () => {
  assert.equal(
    isSeiCaptchaWall(
      'Digite o código da imagem <img id="imgCaptcha"> txtInfraCaptcha',
      'Digite o código da imagem'
    ),
    true
  );
});

test('processo não encontrado é vazio', () => {
  assert.equal(isSeiEmptyOrMissing('x', 'Processo não encontrado.'), true);
});

console.log('\n== Fingerprint SEI (extração) ==');
const monitorPath = fileURLToPath(new URL('../server/monitor.js', import.meta.url));
const exportPath = fileURLToPath(new URL('../server/_smoke_export.mjs', import.meta.url));
const src = readFileSync(monitorPath, 'utf8');
writeFileSync(
  exportPath,
  src.replace(
    'export async function checkMonitor',
    'export { extractSeiRelevantText, summarizeDiff, detectUnusableCapture, hashContent };\nexport async function checkMonitor'
  )
);
const mon = await import(pathToFileURL(exportPath).href + `?t=${Date.now()}`);

const seiHtml = `
<html><body>
<div>Lista de Protocolos</div>
<table>
<tr><th>Protocolo</th><th>Tipo</th><th>Data</th><th>Unidade</th></tr>
<tr><td>138044041 <img src="/infra_css/imagens/chave.gif" alt="restrito" /></td><td>Despacho de Encaminhamento de Processo</td><td>05/08/2026</td><td>SEPPEN/ASSJUR</td></tr>
<tr><td><a href="/sei/documento?id=138150689">138150689</a></td><td>Despacho de Encaminhamento de Processo</td><td>06/08/2026</td><td>SEPPEN/SUPRH</td></tr>
<tr><td><a href="/sei/documento?id=138456309">138456309</a></td><td>Ofício - NA 133</td><td>06/08/2026</td><td>SEPPEN/CHEGAB</td></tr>
</table>
<div>Lista de Andamentos (28 registros):</div>
<table>
<tr><th>Data/Hora</th><th>Unidade</th><th>Descrição</th></tr>
<tr><td>06/08/2026 18:45:33</td><td>SEPPEN/GABSEC</td><td>Processo remetido pela unidade SEPPEN/CHEGAB</td></tr>
<tr><td>06/08/2026 18:44:01</td><td>SEPPEN/CHEGAB</td><td>Processo recebido na unidade</td></tr>
</table>
<img id="imgCaptcha" /><label>Digite o código da imagem</label>
<input name="txtInfraCaptcha" />
<script>var tok="${'Ab12'.repeat(40)}"</script>
</body></html>`;

const fp1 = mon.extractSeiRelevantText(seiHtml);
const fp2 = mon.extractSeiRelevantText(seiHtml.replace(/:\d{2}(?=\s|<)/g, ':59'));
const fpChange = mon.extractSeiRelevantText(
  seiHtml.replace('Processo recebido na unidade', 'Processo arquivado na unidade')
);
const fpNewDoc = mon.extractSeiRelevantText(
  seiHtml.replace(
    '</table>\n<img',
    `<tr><td>139000001</td><td>Despacho de Encaminhamento de Processo</td><td>06/08/2026</td><td>SEPPEN/X</td></tr></table>\n<img`
  )
);
const seiLocked = seiHtml
  .replace(
    '<td><a href="/sei/documento?id=138150689">138150689</a></td>',
    '<td>138150689 <img src="/infra_css/imagens/chave.gif" alt="restrito" /></td>'
  )
  .replace(
    '<td><a href="/sei/documento?id=138456309">138456309</a></td>',
    '<td>138456309</td>'
  );
const fpLocked = mon.extractSeiRelevantText(seiLocked);
const fpLiberated = mon.extractSeiRelevantText(seiHtml);

test('extrai protocolos e andamentos', () => {
  assert.match(fp1, /\[protocolos\]/);
  assert.match(fp1, /\[andamentos\]/);
  assert.match(fp1, /138456309/);
  assert.match(fp1, /Processo remetido/);
});

test('marca documentos com link como liberados e sem link como restritos', () => {
  assert.match(fp1, /138150689 \| liberado \|/);
  assert.match(fp1, /138456309 \| liberado \|/);
  assert.match(fp1, /138044041 \| restrito \|/);
});

test('ignora segundos e tokens (sem falso positivo)', () => {
  assert.equal(fp1, fp2);
  assert.equal(mon.hashContent(fp1), mon.hashContent(fp2));
});

test('detecta mudança real de andamento', () => {
  assert.notEqual(fp1, fpChange);
  assert.match(mon.summarizeDiff(fp1, fpChange).summary, /Processo:/);
});

test('detecta documento novo', () => {
  assert.notEqual(fp1, fpNewDoc);
  assert.match(mon.summarizeDiff(fp1, fpNewDoc).summary, /\+1/);
});

test('detecta liberação preto→azul (restrito→liberado)', () => {
  assert.notEqual(fpLocked, fpLiberated);
  assert.match(fpLocked, /138150689 \| restrito \|/);
  assert.match(fpLiberated, /138150689 \| liberado \|/);
  const summary = mon.summarizeDiff(fpLocked, fpLiberated).summary;
  assert.match(summary, /liberado/i);
});

test('página com captcha + conteúdo útil não é bloqueada', () => {
  assert.equal(mon.detectUnusableCapture(seiHtml, fp1), null);
});

test('captcha sem tabelas é ignorado', () => {
  const empty = mon.extractSeiRelevantText(
    '<html><body>Digite o código da imagem<img id="imgCaptcha"></body></html>'
  );
  assert.equal(empty, '');
  assert.ok(mon.detectUnusableCapture('Digite o código da imagem', empty));
});

unlinkSync(exportPath);

console.log('\n== Auth PATCH emailNotifyDailyLimit (unidade) ==');
// Simulate normalize + effective limit path without writing disk
test('Math path do PATCH mantém valor 10→25', () => {
  const patched = Math.max(0, Math.min(500, Number(25) || 0));
  assert.equal(patched, 25);
  assert.equal(getEffectiveEmailDailyLimit({ emailNotifyDailyLimit: patched }), 25);
});

console.log(`\n${failed ? `FALHOU: ${failed} teste(s)` : 'TODOS OS TESTES PASSARAM'}\n`);
process.exit(failed ? 1 : 0);
