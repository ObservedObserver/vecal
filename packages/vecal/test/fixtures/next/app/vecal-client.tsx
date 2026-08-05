'use client';

import { useEffect, useState } from 'react';
import { VectorDB } from 'vecal';

export function VecalClient() {
    const [state, setState] = useState('opening');
    useEffect(() => {
        let active = true;
        let database: Awaited<ReturnType<typeof VectorDB.open>> | undefined;
        void VectorDB.open({ name: 'next-consumer', dimension: 3, metric: 'cosine' }).then((db) => {
            database = db;
            if (active) setState('ready');
        });
        return () => {
            active = false;
            void database?.close();
        };
    }, []);
    return <output>{state}</output>;
}
