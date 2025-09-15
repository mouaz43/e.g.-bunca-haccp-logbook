import { Router } from 'express';

const router = Router();

// Home -> simple landing stub (we'll replace later)
router.get('/', (req, res) => {
  res.render('pages/index', { title: 'Start' });
});

// Login page (UI only for now)
router.get('/login', (req, res) => {
  res.render('pages/login', { title: 'Anmelden' });
});

export default router;
