/**
 * سكربت لتوليد جلسة تيليجرام جديدة (Session String)
 * 
 * الخطوات:
 * 1. أوقف البوت على Render أولاً
 * 2. شغّل هذا السكربت: node generate_session.js
 * 3. أدخل رقم هاتفك والكود
 * 4. انسخ الـ Session String الجديد
 * 5. حدّث TELEGRAM_STRING_SESSION في Render
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
require('dotenv').config();

const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;

if (!API_ID || !API_HASH) {
  console.error('❌ TELEGRAM_API_ID أو TELEGRAM_API_HASH غير موجود في ملف .env');
  process.exit(1);
}

(async () => {
  console.log('🔑 توليد جلسة تيليجرام جديدة...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  // نبدأ بجلسة فارغة (جديدة تماماً)
  const stringSession = new StringSession('');

  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('📱 أدخل رقم هاتفك (مثال: +966501234567): '),
    password: async () => await input.password('🔒 أدخل كلمة مرور المصادقة الثنائية (إذا مفعّلة): '),
    phoneCode: async () => await input.text('✉️ أدخل الكود اللي وصلك على تيليجرام: '),
    onError: (err) => console.error('❌ خطأ:', err.message),
  });

  console.log('\n✅ تم تسجيل الدخول بنجاح!');
  
  const me = await client.getMe();
  console.log(`👤 مسجّل كـ: ${me.firstName} ${me.lastName || ''} (@${me.username || 'N/A'})`);

  const newSession = client.session.save();
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 الجلسة الجديدة (Session String):');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(newSession);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  console.log('\n📋 الخطوات التالية:');
  console.log('1. انسخ الجلسة من فوق');
  console.log('2. روح Render → Environment Variables');
  console.log('3. حدّث TELEGRAM_STRING_SESSION بالقيمة الجديدة');
  console.log('4. اعمل Deploy للكود الجديد');
  console.log('5. لا تشغّل البوت محلياً بنفس الجلسة!');
  
  // حفظ الجلسة في ملف .env المحلي أيضاً
  const fs = require('fs');
  const path = require('path');
  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    if (envContent.includes('TELEGRAM_STRING_SESSION=')) {
      envContent = envContent.replace(/TELEGRAM_STRING_SESSION=.*/, `TELEGRAM_STRING_SESSION=${newSession}`);
    } else {
      envContent += `\nTELEGRAM_STRING_SESSION=${newSession}`;
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log('\n✅ تم حفظ الجلسة الجديدة في ملف .env تلقائياً');
  } catch (err) {
    console.error('\n⚠️ ما قدرت أحفظ في .env، انسخ الجلسة يدوياً');
  }
  
  await client.disconnect();
  process.exit(0);
})();
