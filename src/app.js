import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import pagesRouter from './routes/pages.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Security + perf
app.use(helmet({
  contentSecurityPolicy: false // keep simple for EJS + inline in dev; tighten later
}));
app.use(compression());
app.use(morgan('dev'));

// Parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Views
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// App locals
app.locals.APP_NAME = process.env.APP_NAME || 'BUNCA HACCP';

// Routes
app.use('/', pagesRouter);

// 404
app.use((req, res) => {
  res.status(404).render('pages/404', { title: 'Seite nicht gefunden' });
});

// 500
app.use((err, req, res, _next) => {
  console.error('❌', err);
  res.status(500).render('pages/500', { title: 'Fehler', error: err });
});

export default app;
