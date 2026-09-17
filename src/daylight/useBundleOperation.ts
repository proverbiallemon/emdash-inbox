import * as React from 'react';
import {
  BundleOperationClient,
  operationStorageKey,
  readOperation,
  type OperationReference,
} from './bundleClient';
import { postInbox } from '../lib/attachmentClient';
import type { BundleId } from '../lib/bundles';

export function useBundleOperation(userId: string | null, onChanged: () => void) {
  const [reference, setReference] = React.useState<OperationReference | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const changed = React.useRef(onChanged);
  changed.current = onChanged;
  const client = React.useRef<BundleOperationClient | null>(null);

  React.useEffect(() => {
    let active = true;
    const restored = readOperation(userId);
    setReference(restored);
    setError('');

    const instance = new BundleOperationClient(
      postInbox,
      value => {
        if (!active) return;
        setReference({ ...value });
        if (userId) {
          try {
            localStorage.setItem(operationStorageKey(userId), JSON.stringify(value));
          } catch {
            setError('Browser storage is unavailable. Keep this page open to retain recovery details.');
          }
        }
      },
      restored,
    );
    client.current = instance;

    if (restored) {
      setBusy(true);
      instance
        .reconcile()
        .then(() => {
          if (active) changed.current();
        })
        .catch(e => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }

    return () => {
      active = false;
      instance.stop();
    };
  }, [userId]);

  const perform = async (action: (instance: BundleOperationClient) => Promise<void>) => {
    const instance = client.current;
    if (!instance) return;
    setBusy(true);
    setError('');
    try {
      await action(instance);
      changed.current();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check this operation.');
    } finally {
      setBusy(false);
    }
  };

  return {
    reference,
    busy,
    error,
    prepare: (bundle: BundleId) => perform(instance => instance.prepare(bundle, crypto.randomUUID())),
    run: (retry = false) => perform(instance => instance.run(retry)),
    reconcile: () => perform(instance => instance.reconcile()),
    resumePreparation: () =>
      perform(instance => instance.prepare(instance.reference!.bundle, instance.reference!.requestId)),
    dismiss: () => {
      if (busy || !client.current?.clear()) return;
      setReference(null);
      setError('');
      if (userId) {
        try {
          localStorage.removeItem(operationStorageKey(userId));
        } catch {
          setError('Could not clear the saved result from this browser.');
        }
      }
    },
  };
}
