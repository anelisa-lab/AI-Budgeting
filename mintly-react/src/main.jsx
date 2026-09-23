/**
 * Application entry point.
 * Member 7.
 *
 * Provider order matters and is not arbitrary:
 *   Router   — the rest can navigate
 *   Toast    — anything below can raise feedback
 *   Auth     — owns the token
 *   Budget   — needs the token
 *   Shopping — the student's list, shared by Search, Compare and the nav
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { BudgetProvider } from './context/BudgetContext.jsx';
import { ShoppingProvider } from './context/ShoppingContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';

import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* Opt in to the v7 behaviour now, so the console stays quiet. */}
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <AuthProvider>
          <BudgetProvider>
            <ShoppingProvider>
              <App />
            </ShoppingProvider>
          </BudgetProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
