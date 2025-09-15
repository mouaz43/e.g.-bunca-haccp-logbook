import 'dotenv/config';
import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ ${process.env.APP_NAME || 'BUNCA HACCP'} running on http://localhost:${PORT}`);
});
