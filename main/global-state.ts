export type NyaoGlobal = typeof globalThis & NodeJS.Global & {
    config_dir_path: string;
    nyaovimrc_path: string;
};

export const nyaoGlobal = globalThis as NyaoGlobal;
