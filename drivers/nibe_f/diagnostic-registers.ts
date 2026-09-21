import {Dir, Register} from '../../lib/registers';

// Read-only diagnostic candidates; never included in discovery or allocation.
export const diagnosticRegisters: Register[] = [
    {
        "address": 42445,
        "name": "energy_counter.h42445_compressor_produced",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 32,
        "signed": false,
        "scale": 10,
        "info": {"en": "System hot-water compressor production. Diagnostic only.", "sv": "Producerad kompressorenergi. Endast diagnostik."}
    },
    {
        "address": 42447,
        "name": "energy_counter.h42447_compressor_produced",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 32,
        "signed": false,
        "scale": 10,
        "info": {"en": "System heating compressor production. Diagnostic only.", "sv": "Producerad kompressorenergi. Endast diagnostik."}
    },
    {
        "address": 44306,
        "name": "energy_counter.h44306_compressor_produced",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 32,
        "signed": false,
        "scale": 10,
        "info": {"en": "EP14 hot-water compressor production. Diagnostic only.", "sv": "Producerad kompressorenergi. Endast diagnostik."}
    },
    {
        "address": 44308,
        "name": "energy_counter.h44308_compressor_produced",
        "direction": Dir.Out,
        "group": "electrical",
        "noAction": true,
        "internal": true,
        "size": 32,
        "signed": false,
        "scale": 10,
        "info": {"en": "EP14 heating compressor production. Diagnostic only.", "sv": "Producerad kompressorenergi. Endast diagnostik."}
    },
];
