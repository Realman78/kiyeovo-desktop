import * as React from "react";

type LogoProps = {
    version: "1" | "2";
}
export const Logo = ({ version }: LogoProps) => {
    return <svg
        xmlns="http://www.w3.org/2000/svg"
        width={276}
        height={276}
        viewBox="0 0 276 276"
    >
        <defs>
            <style>{"\n      :root { --bg:#0b0e13; --fg:#19d5e6; }\n    "}</style>
        </defs>
        <circle cx={138} cy={138} r={138} fill="var(--bg)" />
        <g fill="var(--fg)" shapeRendering="crispEdges" transform="translate(16 16)">
            <rect x={67} y={37} width={24} height={176} />
            <rect x={91} y={111} width={24} height={24} />
            <rect x={166} y={37} width={24} height={24} />
            <rect x={141} y={62} width={24} height={24} />
            <rect x={115} y={87} width={24} height={24} />
            <rect x={115} y={138} width={24} height={24} />
            <rect x={141} y={163} width={24} height={24} />
            <rect x={166} y={189} width={24} height={24} />
            {version === "2" && <>
                <rect x={67} y={111} width={24} height={24} fill="var(--bg)" />
                <rect x={67} y={62} width={24} height={24} fill="var(--bg)" />
                <rect x={67} y={163} width={24} height={24} fill="var(--bg)" />
            </>}
        </g>
    </svg>
}