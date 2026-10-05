import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({ plugins:[react()], base:'/ui/', build:{outDir:path.resolve(process.cwd(),'../public/ui'), emptyOutDir:true}});
