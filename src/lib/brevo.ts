export async function brevoSubscribe(list: string, retries = 2): Promise<boolean> {
  try {
    const userData = JSON.parse(sessionStorage.getItem('userData') || '{}');
    if (!userData.email) return false;

    for (let i = 0; i <= retries; i++) {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: userData.name || '', email: userData.email, phone: userData.phone || '', list }),
      });
      const json = await res.json();
      if (json.success) return true;
      if (i < retries) await new Promise(r => setTimeout(r, 800));
    }
    return false;
  } catch {
    return false;
  }
}
