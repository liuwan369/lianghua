import './style.css';
import './pages/settings.css';
import './pages/rewards.css';
import { mountLayout } from './layout';
import { connect } from './live-data';

mountLayout(document.getElementById('app')!);
connect();
