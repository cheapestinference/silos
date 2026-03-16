import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { createElement } from 'react';
import {
  auth,
  googleProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  firebaseSignOut,
  onAuthStateChanged,
  type User,
} from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      const gaId = (window as any).__GA_ID;
      if (typeof window.gtag === 'function' && gaId) {
        window.gtag('config', gaId, { user_id: firebaseUser?.uid });
      }
    });
    return unsubscribe;
  }, []);

  const signInFn = useCallback(async (email: string, password: string) => {
    if (!auth) throw new Error('Auth not configured');
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const signInWithGoogleFn = useCallback(async () => {
    if (!auth) throw new Error('Auth not configured');
    await signInWithPopup(auth, googleProvider);
  }, []);

  const signOut = useCallback(async () => {
    if (!auth) return;
    await firebaseSignOut(auth);
  }, []);

  const getIdToken = useCallback(async (): Promise<string> => {
    if (!auth?.currentUser) {
      throw new Error('Not authenticated');
    }
    return auth.currentUser.getIdToken();
  }, []);

  const value: AuthContextType = {
    user,
    loading,
    signIn: signInFn,
    signInWithGoogle: signInWithGoogleFn,
    signOut,
    getIdToken,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
